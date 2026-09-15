import ReactMarkdown, { type Components } from 'react-markdown'

/**
 * Release notes and notices, written in Markdown.
 *
 * Raw HTML in the source is not rendered, only Markdown's own elements, and a
 * link is kept only when it is a web address — it opens in the system browser.
 * Images are left out: a notice has no business loading pictures from
 * wherever its text points.
 */

const components: Components = {
  a: ({ href, children }) =>
    href && /^https?:\/\//i.test(href) ? (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ) : (
      <>{children}</>
    ),
  img: () => null
}

export default function Markdown({ source }: { source: string }): React.JSX.Element {
  return (
    <div className="markdown">
      <ReactMarkdown components={components} skipHtml>
        {source}
      </ReactMarkdown>
    </div>
  )
}
