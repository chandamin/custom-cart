import { authenticate } from "../shopify.server";
import db from "../db.server";

// Every variant created by apps.custom-cart.create-variant.jsx is single-use
// (it exists only to hold one order's garment+add-ons price). Once the order
// it was added to is actually paid, it has served its purpose and is deleted
// from Shopify so it doesn't pile up in the product's variant list.
export const action = async ({ request }) => {
  const { shop, session, topic, payload, admin } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (!session || !admin) return new Response();

  const orderedVariantIds = (payload.line_items ?? [])
    .map((item) => (item.variant_id ? String(item.variant_id) : null))
    .filter(Boolean);

  if (orderedVariantIds.length === 0) return new Response();

  const generated = await db.generatedVariant.findMany({
    where: { shop, variantId: { in: orderedVariantIds }, removedAt: null },
  });

  if (generated.length === 0) return new Response();

  const byProduct = new Map();
  for (const record of generated) {
    const ids = byProduct.get(record.productId) ?? [];
    ids.push(`gid://shopify/ProductVariant/${record.variantId}`);
    byProduct.set(record.productId, ids);
  }

  for (const [productId, variantsIds] of byProduct) {
    await admin.graphql(
      `#graphql
        mutation DeleteGeneratedVariants($productId: ID!, $variantsIds: [ID!]!) {
          productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
            userErrors {
              field
              message
            }
          }
        }`,
      { variables: { productId, variantsIds } },
    );
  }

  await db.generatedVariant.updateMany({
    where: { id: { in: generated.map((record) => record.id) } },
    data: { removedAt: new Date() },
  });

  return new Response();
};
