import { authenticate } from "../shopify.server";

// Called from the storefront (via the /apps/custom-cart app proxy) right before
// add-to-cart. Instead of relying on the Cart Transform function to merge the
// garment line with its print-option add-on lines at checkout — which needs
// Shopify Plus for a custom app — this creates one real variant on the same
// product, priced at garment + add-ons combined, so a Basic-plan store gets a
// single correctly-priced line without any Function involved.
//
// Prices are recomputed here from the variants' real Admin data rather than
// trusting whatever total the browser sends, so a tampered request can't
// produce an under-priced variant.
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
      }`,
    { variables: { ids: [mainVariantId, ...addonVariantIds] } },
  );
  const { data: pricingData } = await pricesResponse.json();
  const [mainVariant, ...addonVariants] = pricingData.nodes;

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

  // Reuse the garment's own Color/Size selection so the new variant sits in
  // the same option combination, plus a unique Custom value so it doesn't
  // collide with any other generated variant.
  const optionValues = mainVariant.selectedOptions
    .filter((option) => option.name !== "Custom")
    .map((option) => ({ optionName: option.name, name: option.value }));
  optionValues.push({
    optionName: "Custom",
    name: `Bundle-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  });

  const createResponse = await admin.graphql(
    `#graphql
      mutation CreateCustomVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkCreate(productId: $productId, variants: $variants) {
          productVariants {
            id
            price
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
        variants: [
          {
            price: totalUnitPrice,
            optionValues,
          },
        ],
      },
    },
  );
  const { data: createData } = await createResponse.json();
  const userErrors = createData.productVariantsBulkCreate.userErrors;

  if (userErrors.length > 0) {
    return Response.json({ error: userErrors }, { status: 422 });
  }

  const [newVariant] = createData.productVariantsBulkCreate.productVariants;

  return Response.json({
    variantId: newVariant.id,
    price: newVariant.price,
    properties: {
      custom: "true",
      _addon_for: mainVariant.id,
    },
  });
};

// Picks the per-unit price for the highest quantity-break tier the requested
// quantity qualifies for, falling back to the variant's base price when it
// has no quantity price breaks configured.
function tieredUnitPrice(variant, quantity) {
  const breaks = variant.quantityPriceBreaks?.nodes ?? [];
  if (breaks.length === 0) return parseFloat(variant.price);

  const applicable = breaks
    .filter((tier) => quantity >= tier.minimumQuantity)
    .sort((a, b) => b.minimumQuantity - a.minimumQuantity)[0];

  return applicable
    ? parseFloat(applicable.price.amount)
    : parseFloat(variant.price);
}

// A product only needs the "Custom" option created once; after that every
// call just adds a new value under it via productVariantsBulkCreate.
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
  const { data } = await response.json();
  const existing = data.product.options.find((option) => option.name === "Custom");
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
  const { data: createData } = await createResponse.json();
  if (createData.productOptionsCreate.userErrors.length > 0) return null;

  const created = createData.productOptionsCreate.product.options.find(
    (option) => option.name === "Custom",
  );
  return created?.id ?? null;
}
