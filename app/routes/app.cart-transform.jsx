import { useEffect } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

// A Cart Transform function isn't active on a shop just because it's deployed —
// it must be registered once via `cartTransformCreate`, and a shop can only have
// one active Cart Transform function at a time. This page lists this app's
// cart-transform functions and any already-active registration, and lets the
// merchant activate or remove one.
export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(
    `#graphql
      query CartTransformSetup {
        shopifyFunctions(first: 25) {
          nodes {
            id
            apiType
            title
          }
        }
        cartTransforms(first: 5) {
          nodes {
            id
            functionId
          }
        }
      }`,
  );
  const { data } = await response.json();

  return {
    functions: data.shopifyFunctions.nodes.filter(
      (fn) => fn.apiType === "cart_transform",
    ),
    activeCartTransforms: data.cartTransforms.nodes,
  };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "activate") {
    const functionId = formData.get("functionId");
    const response = await admin.graphql(
      `#graphql
        mutation ActivateCartTransform($functionId: String!) {
          cartTransformCreate(functionId: $functionId) {
            cartTransform {
              id
              functionId
            }
            userErrors {
              field
              message
            }
          }
        }`,
      { variables: { functionId } },
    );
    const { data } = await response.json();
    return { result: data.cartTransformCreate };
  }

  if (intent === "deactivate") {
    const id = formData.get("id");
    const response = await admin.graphql(
      `#graphql
        mutation DeactivateCartTransform($id: ID!) {
          cartTransformDelete(id: $id) {
            deletedId
            userErrors {
              field
              message
            }
          }
        }`,
      { variables: { id } },
    );
    const { data } = await response.json();
    return { result: data.cartTransformDelete };
  }

  return null;
};

export default function CartTransformSetup() {
  const { functions, activeCartTransforms } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const isSubmitting = fetcher.state !== "idle";

  useEffect(() => {
    const errors = fetcher.data?.result?.userErrors;
    if (errors?.length) {
      shopify.toast.show(errors.map((e) => e.message).join(", "), {
        isError: true,
      });
    } else if (fetcher.data?.result) {
      shopify.toast.show("Cart transform updated");
    }
  }, [fetcher.data, shopify]);

  const activate = (functionId) =>
    fetcher.submit({ intent: "activate", functionId }, { method: "POST" });
  const deactivate = (id) =>
    fetcher.submit({ intent: "deactivate", id }, { method: "POST" });

  return (
    <s-page heading="Cart transform">
      <s-section heading="Merge print-option add-ons into one line">
        <s-paragraph>
          Activating this registers the <s-text fontWeight="bold">merge-print-addons</s-text>{" "}
          function so it can combine the garment line and its print-option
          add-on lines (matched by a shared <s-text fontWeight="bold">_bundle_id</s-text>{" "}
          cart line property) into a single priced line, in both the cart and
          checkout. A shop can only have one active cart transform function at
          a time.
        </s-paragraph>

        {activeCartTransforms.length > 0 && (
          <s-stack direction="block" gap="base">
            <s-heading>Currently active</s-heading>
            {activeCartTransforms.map((ct) => (
              <s-stack key={ct.id} direction="inline" gap="base">
                <s-text>{ct.functionId}</s-text>
                <s-button
                  variant="tertiary"
                  onClick={() => deactivate(ct.id)}
                  {...(isSubmitting ? { loading: true } : {})}
                >
                  Deactivate
                </s-button>
              </s-stack>
            ))}
          </s-stack>
        )}

        {functions.length === 0 ? (
          <s-paragraph>
            No cart transform functions found for this app yet. Run{" "}
            <s-text fontWeight="bold">shopify app deploy</s-text> after linking
            the app to a store, then reload this page.
          </s-paragraph>
        ) : (
          <s-stack direction="block" gap="base">
            {functions.map((fn) => (
              <s-stack key={fn.id} direction="inline" gap="base">
                <s-text>{fn.title}</s-text>
                <s-button
                  onClick={() => activate(fn.id)}
                  {...(isSubmitting ? { loading: true } : {})}
                >
                  Activate
                </s-button>
              </s-stack>
            ))}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
