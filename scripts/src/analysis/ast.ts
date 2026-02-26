import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Parser, Language } = require("web-tree-sitter");

let parser: any | null = null;
let pythonLang: any | null = null;

async function initParser() {
  if (parser) return parser;

  await Parser.init();
  parser = new Parser();

  try {
    const wasmPath = require.resolve("tree-sitter-python/tree-sitter-python.wasm");
    pythonLang = await Language.load(wasmPath);
    parser.setLanguage(pythonLang);
  } catch (e) {
    console.error("Failed to load tree-sitter-python:", e);
    throw e;
  }

  return parser;
}

export async function extractPythonImports(content: string): Promise<string[]> {
  try {
    const p = await initParser();
    const tree = p.parse(content);
    const imports: string[] = [];

    // Simple robust query for imports
    // Handle:
    // import foo
    // import foo.bar
    // from foo import bar
    // from . import bar
    // from ..sub import bar

    // We walk the tree to find import_statement and import_from_statement
    const cursor = tree.walk();

    // Recursive walker
    function visit(node: any) {
      if (node.type === "import_statement") {
        // children: import_prefix? dotted_name (as_pattern)? ...
        // We just want the dotted_names
        node.children.forEach((c: any) => {
           if (c.type === "dotted_name") imports.push(c.text);
           // e.g. import x, y -> multiple dotted_names
           if (c.type === "aliased_import") {
               // alias is 'x as y' -> child[0] is name
               const name = c.child(0);
               if (name && name.type === "dotted_name") imports.push(name.text);
           }
        });
      } else if (node.type === "import_from_statement") {
         // Pattern: from .sub import x  -> relative_import=".", module_name="sub"
         // Pattern: from .. import x    -> relative_import=".."
         // Pattern: from foo import x   -> module_name="foo"

         let importPart = "";
         const relNode = node.children.find((c: any) => c.type === "relative_import");
         const moduleNode = node.childForFieldName("module_name");

         if (relNode && moduleNode && relNode.startIndex === moduleNode.startIndex) {
              importPart = relNode.text;
         } else {
              if (relNode) importPart += relNode.text;
              if (moduleNode) importPart += moduleNode.text;
         }

         if (importPart) {
             imports.push(importPart);
         } else {
             // Fallback if structure is unexpected, though above covers most cases
             node.children.forEach((c: any) => {
                 if (c.type === "relative_import") imports.push(c.text);
                 if (c.type === "dotted_name") imports.push(c.text);
             });
         }
      }

      if (node.childCount > 0) {
        for (let i = 0; i < node.childCount; i++) {
          visit(node.child(i));
        }
      }
    }

    visit(tree.rootNode);

    // Clean up: remove duplicates and simple dots if not useful, though relative imports like ".." need resolution context
    return [...new Set(imports)];
  } catch (e) {
      console.warn("Tree-sitter parse error for imports:", e);
      return [];
  }
}

export async function getPythonSkeleton(content: string): Promise<string> {
  try {
    const p = await initParser();
    const tree = p.parse(content);

    let rangesToOmit: {start: number, end: number}[] = [];

    function visit(node: any) {
      if (node.type === "function_definition") {
          const body = node.childForFieldName("body");
          if (body) {
              rangesToOmit.push({ start: body.startIndex, end: body.endIndex });
              // Do NOT recurse into function body (we replace it all)
              return;
          }
      }
      // If class, we DO recurse likely to find methods
      if (node.type === "class_definition") {
          // But what about the class "body" block?
          // We want to keep the class body structure (indentation, method headers) but prune method bodies.
          // So we continue recursion.
      }

      if (node.childCount > 0) {
          for (let i = 0; i < node.childCount; i++) {
              visit(node.child(i));
          }
      }
    }

    visit(tree.rootNode);

    // Sort ranges and construct new string
    rangesToOmit.sort((a,b) => a.start - b.start);

    let result = "";
    let lastUncopiedIndex = 0;

    for (const range of rangesToOmit) {
        if (range.start < lastUncopiedIndex) continue; // Should not happen with proper traversal but safety

        result += content.slice(lastUncopiedIndex, range.start);

        // Count newlines in the skipped section to preserve line numbers
        const skippedContent = content.slice(range.start, range.end);
        const newlineCount = (skippedContent.match(/\n/g) || []).length;

        result += " ... " + "\n".repeat(newlineCount);

        lastUncopiedIndex = range.end;
    }
    result += content.slice(lastUncopiedIndex);

    return result;
  } catch(e) {
      console.warn("Tree-sitter parse error for skeleton:", e);
      return content; // Fallback to full content on error
  }
}
