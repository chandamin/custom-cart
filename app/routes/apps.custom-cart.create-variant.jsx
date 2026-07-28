import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.public.appProxy(request);

  if (!session || !admin) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { productId, mainVariantId, addonVariantIds, quantity } = body;

  if (
    !productId ||
    !mainVariantId ||
    !Array.isArray(addonVariantIds) ||
    !Number.isFinite(quantity) ||
    quantity < 1
  ) {
    return Response.json({ error: "Missing or invalid fields" }, { status: 400 });
  }

  const pricesResponse = await admin.graphql(
    `#graphql
      query VariantPricing($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            price
            selectedOptions {
              name
              value
            }
            media(first: 1) {
              nodes {
                id
              }
            }
            contextualPricing(context: {}) {
              quantityPriceBreaks(first: 10) {
                nodes {
                  minimumQuantity
                  price {
                    amount
                  }
                }
              }
            }
          }
        }
      }`,
    { variables: { ids: [mainVariantId, ...addonVariantIds] } },
  );
  const pricingBody = await pricesResponse.json();
  if (!pricingBody.data) {
    return Response.json({ error: pricingBody.errors ?? "Pricing query failed" }, { status: 500 });
  }
  const [mainVariant, ...addonVariants] = pricingBody.data.nodes;

  if (!mainVariant) {
    return Response.json({ error: "Main variant not found" }, { status: 404 });
  }

  const mainUnitPrice = tieredUnitPrice(mainVariant, quantity);
  const addonsUnitPrice = addonVariants.reduce(
    (sum, variant) => sum + (variant ? parseFloat(variant.price) : 0),
    0,
  );
  const totalUnitPrice = (mainUnitPrice + addonsUnitPrice).toFixed(2);

  const customOptionId = await ensureCustomOption(admin, productId);
  if (!customOptionId) {
    return Response.json(
      { error: "Could not find or create the 'Custom' option on this product" },
      { status: 500 },
    );
  }

  // NEW: fetch a location to stock the new variant at
  const locationId = await getPrimaryLocationId(admin);
  if (!locationId) {
    return Response.json(
      { error: "Could not find a location to stock the variant" },
      { status: 500 },
    );
  }

  const optionValues = mainVariant.selectedOptions
    .filter((option) => option.name !== "Custom")
    .map((option) => ({ optionName: option.name, name: option.value }));
  optionValues.push({
    optionName: "Custom",
    name: `Bundle-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  });

  // Reuse the garment variant's own image so the cart line shows the real
  // product photo instead of a placeholder.
  const mediaId = mainVariant.media?.nodes?.[0]?.id;

  const createResponse = await admin.graphql(
    `#graphql
      mutation CreateCustomVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $strategy: ProductVariantsBulkCreateStrategy) {
        productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: $strategy) {
          productVariants {
            id
            price
            inventoryItem {
              id
            }
          }
          userErrors {
            field
            message
          }
        }
      }`,
    {
      variables: {
        productId,
        strategy: "REMOVE_STANDALONE_VARIANT",
        variants: [
          {
            price: totalUnitPrice,
            optionValues,
            inventoryPolicy: "CONTINUE",
            inventoryItem: { tracked: true },
            inventoryQuantities: [
              {
                availableQuantity: quantity,
                locationId,
              },
            ],
            ...(mediaId ? { mediaId } : {}),
          },
        ],
      },
    },
  );
  const createBody = await createResponse.json();
  if (!createBody.data) {
    return Response.json({ error: createBody.errors ?? "Variant creation query failed" }, { status: 500 });
  }
  const createData = createBody.data;
  const userErrors = createData.productVariantsBulkCreate.userErrors;

  if (userErrors.length > 0) {
    return Response.json({ error: userErrors }, { status: 422 });
  }

  const [newVariant] = createData.productVariantsBulkCreate.productVariants;

  await db.generatedVariant.create({
    data: {
      shop: session.shop,
      productId,
      variantId: idFromGid(newVariant.id),
      mainVariantId,
      quantity,
    },
  });

  return Response.json({
    variantId: newVariant.id,
    price: newVariant.price,
    properties: {
      _addon_for: mainVariant.id,
    },
  });
};

function idFromGid(gid) {
  return String(gid).split("/").pop();
}

function tieredUnitPrice(variant, quantity) {
  const breaks = variant.contextualPricing?.quantityPriceBreaks?.nodes ?? [];
  if (breaks.length === 0) return parseFloat(variant.price);

  const applicable = breaks
    .filter((tier) => quantity >= tier.minimumQuantity)
    .sort((a, b) => b.minimumQuantity - a.minimumQuantity)[0];

  return applicable
    ? parseFloat(applicable.price.amount)
    : parseFloat(variant.price);
}

async function ensureCustomOption(admin, productId) {
  const response = await admin.graphql(
    `#graphql
      query ProductOptions($id: ID!) {
        product(id: $id) {
          options {
            id
            name
          }
        }
      }`,
    { variables: { id: productId } },
  );
  const body = await response.json();
  if (!body.data?.product) return null;
  const existing = body.data.product.options.find((option) => option.name === "Custom");
  if (existing) return existing.id;

  const createResponse = await admin.graphql(
    `#graphql
      mutation AddCustomOption($productId: ID!, $options: [OptionCreateInput!]!) {
        productOptionsCreate(productId: $productId, options: $options) {
          product {
            options {
              id
              name
            }
          }
          userErrors {
            field
            message
          }
        }
      }`,
    {
      variables: {
        productId,
        options: [
          {
            name: "Custom",
            values: [{ name: `Bundle-${Date.now()}` }],
          },
        ],
      },
    },
  );
  const createBody = await createResponse.json();
  if (!createBody.data) return null;
  const createData = createBody.data;
  if (createData.productOptionsCreate.userErrors.length > 0) return null;

  const created = createData.productOptionsCreate.product.options.find(
    (option) => option.name === "Custom",
  );
  return created?.id ?? null;
}

// NEW: fetches the shop's first active, fulfillment-eligible location.
// If you need a *specific* location (e.g. the same one the main garment
// variant is stocked at), swap this for a query against
// mainVariant.inventoryItem.inventoryLevels instead of shop.locations.
async function getPrimaryLocationId(admin) {
  const response = await admin.graphql(
    `#graphql
      query PrimaryLocation {
        locations(first: 1, query: "active:true") {
          nodes {
            id
          }
        }
      }`,
  );
  const body = await response.json();
  const location = body.data?.locations?.nodes?.[0];
  return location?.id ?? null;
}