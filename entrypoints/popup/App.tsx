import { useState, useEffect } from 'react';
import './App.css';

interface Account {
  did: string;
  handle: string;
}

function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [handle, setHandle] = useState('');
  const [loginError, setLoginError] = useState('');

  useEffect(() => {
    // Fetch accounts when popup opens
    browser.runtime.sendMessage({ type: 'GET_ACCOUNTS' })
      .then((response) => {
        if (response?.accounts) {
          setAccounts(response.accounts);
        }
        setLoading(false);
      })
      .catch(error => {
        console.error('Error fetching accounts:', error);
        setLoading(false);
      });
  }, []);

  const handleLoginClick = () => {
    // Validate handle
    if (!handle) {
      setLoginError('Please enter your Bluesky handle');
      return;
    }
    
    setLoginError('');
    
    // Initiate the OAuth login flow with the handle
    browser.runtime.sendMessage({ 
      type: 'INITIATE_LOGIN',
      data: { handle }
    })
    .then(response => {
      if (!response.success) {
        setLoginError(response.error || 'Login failed');
      }
    })
    .catch(error => {
      console.error('Failed to initiate login:', error);
      setLoginError('Failed to connect to Bluesky');
    });
  };

  const handleRemoveAccount = (did: string) => {
    browser.runtime.sendMessage({ 
      type: 'REMOVE_ACCOUNT',
      data: { did }
    }).then(() => {
      // Update the list by removing the account
      setAccounts(accounts.filter(account => account.did !== did));
    });
  };

  return (
    <div className="notisky-popup">
      <header>
        <h1>Notisky</h1>
        <p>Real-time notifications for Bluesky</p>
      </header>
      
      {loading ? (
        <div className="loading">Loading...</div>
      ) : accounts.length > 0 ? (
        <div className="accounts">
          <h2>Your Accounts</h2>
          <ul>
            {accounts.map(account => (
              <li key={account.did}>
                <span className="handle">@{account.handle}</span>
                <button 
                  className="remove-btn"
                  onClick={() => handleRemoveAccount(account.did)}
                  title="Remove account"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
          <button onClick={handleLoginClick}>Add Another Account</button>
        </div>
      ) : (
        <div className="login">
          <p>Sign in with your Bluesky account to get started</p>
          <div className="login-form">
            <input
              type="text"
              placeholder="your.handle.bsky.social"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              className="handle-input"
            />
            {loginError && <div className="error-message">{loginError}</div>}
            <button onClick={handleLoginClick}>Login with Bluesky</button>
          </div>
        </div>
      )}
      
      <footer>
        <a href="https://github.com/username/notisky" target="_blank" rel="noopener noreferrer">GitHub</a>
        <span>•</span>
        <a href="#" onClick={() => browser.runtime.openOptionsPage()}>Settings</a>
      </footer>
    </div>
  );
}

export default App;
