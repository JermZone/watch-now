import { useRef } from 'react';

const SearchField = ({ label, onChange, placeholder, value }) => {
  const inputRef = useRef(null);
  return (
    <div className="section-search">
      <input
        aria-label={`Search ${label}`}
        enterKeyHint="done"
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
        placeholder={placeholder}
        ref={inputRef}
        type="search"
        value={value}
      />
      {value !== '' && (
        <button
          aria-label={`Clear ${label} search`}
          className="search-clear-button"
          onClick={() => { onChange(''); inputRef.current?.focus(); }}
          type="button"
        >
          <span aria-hidden="true">×</span>
        </button>
      )}
    </div>
  );
};

export default SearchField;
