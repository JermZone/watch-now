const StatusPanel = ({ diagnostics }) => {
  if (!diagnostics) return null;
  return (
    <div className={`connection-status ${diagnostics.reachable ? 'is-online' : 'is-offline'}`}>
      <span className="status-dot" aria-hidden="true" />
      <span>
        {diagnostics.reachable
          ? 'Dispatcharr connected'
          : 'Dispatcharr is not reachable'}
      </span>
    </div>
  );
};

export default StatusPanel;
