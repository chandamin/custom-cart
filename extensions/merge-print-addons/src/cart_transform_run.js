// @ts-check

/**
 * @typedef {import("../generated/api").CartTransformRunInput} CartTransformRunInput
 * @typedef {import("../generated/api").CartTransformRunResult} CartTransformRunResult
 */

/**
 * @type {CartTransformRunResult}
 */
const NO_CHANGES = {
  operations: [],
};

/**
 * Groups cart lines that share a `_bundle_id` line-item property (already written
 * by the theme's product-option-group / variant-matrix add-to-cart flow) and
 * merges every line in the bundle — the garment line(s) and the print-option
 * add-on lines (flagged `_is_addon: "true"`) — into a single priced line, with
 * each original line shown as a component under it, instead of as separate
 * priced lines in the cart and checkout.
 *
 * The whole bundle is merged in one `linesMerge` operation, even when it
 * contains more than one garment line (e.g. size S and size M added together).
 * An earlier version tried to split each add-on line's quantity proportionally
 * across a separate merge operation per garment line; splitting one cart
 * line's quantity across multiple merge operations turned out to be a
 * documented source of instability in Shopify's Cart Transform API. Merging
 * everything in one operation avoids that: every cart line here is referenced
 * exactly once, with its own real quantity.
 *
 * @param {CartTransformRunInput} input
 * @returns {CartTransformRunResult}
 */
export function cartTransformRun(input) {
  const groups = new Map();

  for (const line of input.cart.lines) {
    const bundleId = line.bundleId && line.bundleId.value;
    if (!bundleId) continue;
    const group = groups.get(bundleId) || [];
    group.push(line);
    groups.set(bundleId, group);
  }

  const operations = [];

  for (const lines of groups.values()) {
    const garmentLines = lines.filter((line) => !isAddon(line));
    const addonLines = lines.filter(isAddon);

    if (garmentLines.length === 0 || addonLines.length === 0) continue;

    // Whichever garment line has the highest quantity represents the bundle
    // for image purposes; the other garment lines still show up as their own
    // components underneath.
    const parent = garmentLines.reduce((biggest, line) =>
      line.quantity > biggest.quantity ? line : biggest,
    );
    if (parent.merchandise.__typename !== "ProductVariant") continue;

    // Without an explicit title, Shopify labels the merged line with the
    // parent variant's own title (e.g. "Iron Grey / M") — which then also
    // shows up a second time as one of the components underneath it. Using
    // the plain product title for the merged line avoids that duplication.
    operations.push({
      linesMerge: {
        cartLines: lines.map((line) => ({
          cartLineId: line.id,
          quantity: line.quantity,
        })),
        parentVariantId: parent.merchandise.id,
        title: parent.merchandise.product.title,
      },
    });
  }

  return operations.length > 0 ? { operations } : NO_CHANGES;
}

function isAddon(line) {
  return Boolean(line.isAddon && line.isAddon.value === "true");
}
