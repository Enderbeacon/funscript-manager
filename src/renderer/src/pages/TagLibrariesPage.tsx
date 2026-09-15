import LibrariesPage from './LibrariesPage'
import OrganisePage from './OrganisePage'

/**
 * Tags and library roots affect the same collection, so wide windows keep
 * both management tools in view instead of making the user switch pages.
 * Each child remains mounted and owns its existing state and subscriptions.
 */
export default function TagLibrariesPage(): React.JSX.Element {
  return (
    <div className="tag-libraries-page">
      <section className="tag-libraries-pane tag-libraries-organise">
        <OrganisePage />
      </section>
      <section className="tag-libraries-pane tag-libraries-libraries">
        <LibrariesPage />
      </section>
    </div>
  )
}
