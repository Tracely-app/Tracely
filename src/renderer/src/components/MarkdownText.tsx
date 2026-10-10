import type { CSSProperties } from 'react'

import { parseMarkdown, type Block, type InlineNode } from '../lib/markdown'

// Renders the subset `lib/markdown.ts` parses, as React elements. Nothing here
// ever produces HTML from a string, so model output cannot inject markup.
//
// **Styled inline rather than with classes, on purpose.** The four renderer
// entries do not share a stylesheet: Tracer ships Tailwind including its
// preflight reset, and the other three rely on `styles/index.css` plus default
// UA styling. Tailwind's preflight strips list markers and heading weights, so
// a class-based version would silently render bullet-less bullets in exactly
// one window. Inline styles land the same in all four, and there is no fourth
// stylesheet to keep in sync.
//
// Sizes are `em`-relative and colours inherit, so this picks up whatever the
// surrounding bubble or card already set.
//
// The one exception is inline code, which also carries the `md-code` class.
// In the windows that load `styles/index.css` that class sets the
// `--md-code-*` custom properties below to the shared inset recipe (12px,
// var(--surface-2), 1px var(--border), radius 4); the overlay window does not
// load that sheet, so there every property falls back to the
// currentColor-derived tint it has always had.

const CONTAINER_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.62em'
}

// `pre-wrap` is what makes this a safe swap. Text with no markdown in it parses
// to a single paragraph holding the input verbatim, so these surfaces render
// byte-for-byte what they rendered before this component existed.
const PARAGRAPH_STYLE: CSSProperties = { margin: 0, whiteSpace: 'pre-wrap' }

const HEADING_STYLE: CSSProperties = { margin: 0, fontWeight: 600, fontSize: '1em' }

const LIST_STYLE: CSSProperties = {
  margin: 0,
  paddingInlineStart: '1.35em',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.28em'
}

const CODE_STYLE: CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
  fontSize: 'var(--md-code-size, 0.92em)',
  // The fallbacks derive from the inherited text colour so one value works on
  // the light cards and the dark theme alike. Unsupported means no tint, not
  // broken text.
  background: 'var(--md-code-bg, color-mix(in srgb, currentColor 10%, transparent))',
  border: 'var(--md-code-border, 0)',
  padding: 'var(--md-code-pad, 0.1em 0.32em)',
  borderRadius: 4
}

function renderInline(nodes: InlineNode[]): JSX.Element[] {
  return nodes.map((node, i) => {
    switch (node.type) {
      case 'text':
        return <span key={i}>{node.value}</span>
      case 'code':
        return (
          <code key={i} className="md-code" style={CODE_STYLE}>
            {node.value}
          </code>
        )
      case 'strong':
        return (
          <strong key={i} style={{ fontWeight: 600 }}>
            {renderInline(node.children)}
          </strong>
        )
      case 'em':
        return (
          <em key={i} style={{ fontStyle: 'italic' }}>
            {renderInline(node.children)}
          </em>
        )
    }
  })
}

function renderBlock(block: Block, key: number): JSX.Element {
  if (block.type === 'heading') {
    return (
      <div key={key} style={HEADING_STYLE}>
        {renderInline(block.children)}
      </div>
    )
  }

  if (block.type === 'list') {
    const Tag = block.ordered ? 'ol' : 'ul'
    return (
      <Tag key={key} style={{ ...LIST_STYLE, listStyleType: block.ordered ? 'decimal' : 'disc' }}>
        {block.items.map((item, i) => (
          <li key={i} style={{ margin: 0 }}>
            {renderInline(item)}
          </li>
        ))}
      </Tag>
    )
  }

  return (
    <p key={key} style={PARAGRAPH_STYLE}>
      {renderInline(block.children)}
    </p>
  )
}

export default function MarkdownText({
  children,
  className,
  style
}: {
  children: string
  className?: string
  style?: CSSProperties
}): JSX.Element {
  const blocks = parseMarkdown(children)
  return (
    <div className={className} style={style ? { ...CONTAINER_STYLE, ...style } : CONTAINER_STYLE}>
      {blocks.map(renderBlock)}
    </div>
  )
}
