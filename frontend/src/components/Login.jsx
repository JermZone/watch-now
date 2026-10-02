import { useEffect, useState } from 'react';

import { getDiagnostics, login } from '../api';
import StatusPanel from './StatusPanel';

const Login = ({ notice, onAuthenticated }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [diagnostics, setDiagnostics] = useState(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    getDiagnostics({ signal: controller.signal })
      .then(setDiagnostics)
      .catch((error) => {
        if (error.name !== 'AbortError') setDiagnostics({ reachable: false });
      });
    return () => controller.abort();
  }, []);

  const submit = async (event) => {
    event.preventDefault();
    if (!username.trim() || !password) return;
    setSubmitting(true);
    setError('');
    try {
      const session = await login(username.trim(), password);
      onAuthenticated(session);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-page">
      <section className="login-card" aria-labelledby="login-title">
        <h1 id="login-title">Watch Now</h1>
        <p className="login-intro">A web player for Dispatcharr.</p>
        <p className="login-intro">
          Sign in with the viewer credentials from your Dispatcharr account.
        </p>

        {notice && <div className="notice" role="status">{notice}</div>}
        {error && <div className="alert" role="alert">{error}</div>}

        <form onSubmit={submit}>
          <label htmlFor="username">Username</label>
          <input
            autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false}
            id="username"
            maxLength={256}
            onChange={(event) => setUsername(event.currentTarget.value)}
            required
            value={username}
          />

          <label htmlFor="password">Password</label>
          <input
            autoComplete="current-password"
            id="password"
            onChange={(event) => setPassword(event.currentTarget.value)}
            required
            type="password"
            value={password}
          />

          <button className="primary-button" disabled={submitting} type="submit">
            {submitting ? 'Connecting…' : 'Open Watch Now'}
          </button>
        </form>

        <StatusPanel diagnostics={diagnostics} />
      </section>
    </main>
  );
};

export default Login;
