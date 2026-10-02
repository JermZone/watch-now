const Pagination = ({ page, total, pageSize = 20, onChange }) => {
  const pages = Math.ceil(total / pageSize);
  if (pages <= 1) return null;
  return (
    <nav aria-label="Pagination" className="pagination">
      <button disabled={page <= 1} onClick={() => onChange(page - 1)} type="button">Previous</button>
      <span>Page {page} of {pages}</span>
      <button disabled={page >= pages} onClick={() => onChange(page + 1)} type="button">Next</button>
    </nav>
  );
};

export default Pagination;
