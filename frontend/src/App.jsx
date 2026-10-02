import LoadingIndicator from './components/LoadingIndicator';
import { useEffect, useState } from 'react';

import { getSession } from './api';
import Login from './components/Login';
import ViewerShell from './components/ViewerShell';

const App = () => {
  const [state, setState] = useState({ status: 'loading', session: null, notice: '' });

  useEffect(() => {
    const controller = new AbortController();
    getSession({ signal: controller.signal })
      .then((session) => setState({ status: 'authenticated', session, notice: '' }))
      .catch((error) => {
        if (error.name !== 'AbortError') {
          setState({ status: 'anonymous', session: null, notice: '' });
        }
      });
    return () => controller.abort();
  }, []);

  if (state.status === 'loading') {
    return (
      <main className="splash" role="status">
        <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
        <LoadingIndicator />
        <p>Opening Watch Now…</p>
      </main>
    );
  }

  if (state.status === 'anonymous') {
    return (
      <Login
        notice={state.notice}
        onAuthenticated={(session) => setState({ status: 'authenticated', session, notice: '' })}
      />
    );
  }

  return (
    <ViewerShell
      onExpired={(notice) => setState({ status: 'anonymous', session: null, notice })}
      session={state.session}
    />
  );
};

export default App;
