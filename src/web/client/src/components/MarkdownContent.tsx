import type { ReactNode } from "react";

type MarkdownBlock =
  | { kind: "code"; content: string }
  | { kind: "divider" }
  | { kind: "heading"; level: number; content: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "paragraph"; content: string }
  | { kind: "quote"; content: string };

export function MarkdownContent(props: { body: string }) {
  const blocks = parseMarkdownBlocks(props.body);

  return (
    <div className="memory-prose">
      {blocks.map((block, index) => renderBlock(block, index))}
    </div>
  );
}

function renderBlock(block: MarkdownBlock, index: number) {
  const key = `${block.kind}-${index}`;
  if (block.kind === "heading") {
    const children = renderInline(block.content);
    if (block.level === 1) {
      return <h2 key={key}>{children}</h2>;
    }
    if (block.level === 2) {
      return <h3 key={key}>{children}</h3>;
    }
    return <h4 key={key}>{children}</h4>;
  }
  if (block.kind === "list") {
    const items = block.items.map((item, itemIndex) => (
      <li key={`${key}-${itemIndex}`}>{renderInline(item)}</li>
    ));
    return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
  }
  if (block.kind === "code") {
    return <pre key={key}><code>{block.content}</code></pre>;
  }
  if (block.kind === "quote") {
    return <blockquote key={key}>{renderInline(block.content)}</blockquote>;
  }
  if (block.kind === "divider") {
    return <hr key={key} />;
  }
  return <p key={key}>{renderInline(block.content)}</p>;
}

// Canonical memories are Markdown. A small allowlist keeps them readable without injecting stored HTML.
function parseMarkdownBlocks(body: string) {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let lineIndex = 0;

  while (lineIndex < lines.length) {
    const line = lines[lineIndex] ?? "";
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      lineIndex += 1;
      continue;
    }

    if (trimmedLine.startsWith("```")) {
      const codeLines: string[] = [];
      lineIndex += 1;
      while (lineIndex < lines.length && !(lines[lineIndex] ?? "").trim().startsWith("```")) {
        codeLines.push(lines[lineIndex] ?? "");
        lineIndex += 1;
      }
      lineIndex += 1;
      blocks.push({ kind: "code", content: codeLines.join("\n") });
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmedLine);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, content: heading[2] });
      lineIndex += 1;
      continue;
    }

    if (/^([-*_])\1{2,}$/.test(trimmedLine)) {
      blocks.push({ kind: "divider" });
      lineIndex += 1;
      continue;
    }

    if (/^[-*]\s+/.test(trimmedLine)) {
      const items: string[] = [];
      while (lineIndex < lines.length) {
        const itemMatch = /^[-*]\s+(.+)$/.exec((lines[lineIndex] ?? "").trim());
        if (!itemMatch) {
          break;
        }
        items.push(itemMatch[1]);
        lineIndex += 1;
      }
      blocks.push({ kind: "list", ordered: false, items });
      continue;
    }

    if (/^\d+\.\s+/.test(trimmedLine)) {
      const items: string[] = [];
      while (lineIndex < lines.length) {
        const itemMatch = /^\d+\.\s+(.+)$/.exec((lines[lineIndex] ?? "").trim());
        if (!itemMatch) {
          break;
        }
        items.push(itemMatch[1]);
        lineIndex += 1;
      }
      blocks.push({ kind: "list", ordered: true, items });
      continue;
    }

    if (trimmedLine.startsWith(">")) {
      const quoteLines: string[] = [];
      while (lineIndex < lines.length) {
        const quoteMatch = /^>\s?(.*)$/.exec((lines[lineIndex] ?? "").trim());
        if (!quoteMatch) {
          break;
        }
        quoteLines.push(quoteMatch[1]);
        lineIndex += 1;
      }
      blocks.push({ kind: "quote", content: quoteLines.join(" ") });
      continue;
    }

    const paragraphLines: string[] = [];
    while (lineIndex < lines.length) {
      const paragraphLine = (lines[lineIndex] ?? "").trim();
      if (paragraphLine.length === 0 || isMarkdownBlockStart(paragraphLine)) {
        break;
      }
      paragraphLines.push(paragraphLine);
      lineIndex += 1;
    }
    blocks.push({ kind: "paragraph", content: paragraphLines.join(" ") });
  }

  return blocks;
}

function isMarkdownBlockStart(line: string) {
  return line.startsWith("```")
    || /^(#{1,4})\s+/.test(line)
    || /^([-*_])\1{2,}$/.test(line)
    || /^[-*]\s+/.test(line)
    || /^\d+\.\s+/.test(line)
    || line.startsWith(">");
}

function renderInline(content: string) {
  const parts = content.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  const rendered: ReactNode[] = [];

  parts.forEach((part, index) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      rendered.push(<code key={index}>{part.slice(1, -1)}</code>);
      return;
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      rendered.push(<strong key={index}>{part.slice(2, -2)}</strong>);
      return;
    }
    rendered.push(part);
  });

  return rendered;
}
