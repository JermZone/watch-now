import LoadingIndicator from './LoadingIndicator';
const CategoryBrowser = ({ categories, error, label, loading, onRetry, onSelect }) => (
  <section className="category-browser" aria-label={`${label} categories`}>
    <p className="section-hint">Choose a category, browse every title alphabetically, or search above.</p>
    <button className="category-card all-titles-card" onClick={() => onSelect('all')} type="button">
      <span aria-hidden="true">☷</span>
      <strong>All Titles A–Z</strong>
    </button>
    {loading ? (
      <div className="loading-state" role="status"><LoadingIndicator />Loading categories…</div>
    ) : error ? (
      <div className="panel-error" role="alert"><p>{error}</p><button onClick={onRetry} type="button">Retry categories</button></div>
    ) : categories.length === 0 ? (
      <p className="empty-state">No {label.toLowerCase()} categories are available.</p>
    ) : (
      <div className="category-grid">
        {categories.map((category) => (
          <button className="category-card" key={category.id} onClick={() => onSelect(category)} type="button">
            <strong>{category.name}</strong>
          </button>
        ))}
      </div>
    )}
  </section>
);

export const BrowseHeader = ({ selection, onBack }) => (
  <div className="browse-header">
    <div><small>Browsing</small><strong>{selection === 'all' ? 'All Titles A–Z' : selection?.name}</strong></div>
    <button className="quiet-button" onClick={onBack} type="button">← Categories</button>
  </div>
);

export default CategoryBrowser;
