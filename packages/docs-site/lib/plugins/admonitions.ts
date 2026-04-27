import type { Root } from "mdast";
import { visit } from "unist-util-visit";

const ADMONITION_TYPES = new Set([
  "note",
  "info",
  "tip",
  "warning",
  "caution",
  "danger",
]);

// mdast directive nodes are not part of the core mdast type set; they live
// on the plugin's own type augmentations. We model the relevant subset
// here to avoid an `any` escape hatch.
type DirectiveNode = {
  type: "containerDirective" | "leafDirective" | "textDirective";
  name: string;
  // biome-ignore lint/suspicious/noExplicitAny: visit() returns a generic node tree
  children: any[];
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
    directiveLabel?: boolean;
  };
};

/**
 * Transforms `:::warning Title ... :::` containerDirective nodes into
 * standard HTML <aside class="admonition warning"> blocks.
 *
 * Source written via `remark-directive` produces a `containerDirective`
 * mdast node with `name` set to the directive type and `children` for
 * content. The first paragraph node may carry the directive label
 * (e.g. `:::warning[The invisible wall]`) under `data.directiveLabel`.
 */
export function remarkAdmonitions() {
  return (tree: Root) => {
    // biome-ignore lint/suspicious/noExplicitAny: the visit callback receives a generic node
    visit(tree, (node: any) => {
      if (
        node.type !== "containerDirective" &&
        node.type !== "leafDirective" &&
        node.type !== "textDirective"
      ) {
        return;
      }
      const directive = node as DirectiveNode;
      if (!ADMONITION_TYPES.has(directive.name)) return;

      if (!directive.data) directive.data = {};
      const data = directive.data;
      data.hName = "aside";
      data.hProperties = {
        className: ["admonition", directive.name],
      };

      // Pull the directive label (text inside `[...]`) out of the first
      // paragraph and render it as an `.admonition-title` div.
      const firstChild = directive.children[0];
      let title: string | null = null;
      if (
        firstChild?.type === "paragraph" &&
        firstChild.data?.directiveLabel === true
      ) {
        title = firstChild.children
          // biome-ignore lint/suspicious/noExplicitAny: text node shape
          ?.map((c: any) => (c.type === "text" ? c.value : ""))
          .join("");
        directive.children.shift();
      }
      // Fallback title when none provided.
      if (!title) {
        title =
          directive.name.charAt(0).toUpperCase() +
          directive.name.slice(1).toLowerCase();
      }

      directive.children.unshift({
        type: "paragraph",
        data: {
          hName: "div",
          hProperties: { className: ["admonition-title"] },
        },
        children: [{ type: "text", value: title }],
      });
    });
  };
}
