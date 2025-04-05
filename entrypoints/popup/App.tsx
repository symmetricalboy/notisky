import { useState, useEffect } from 'react';
import './App.css';
import Login from '../login/Login';

interface Account {
  did: string;
  handle: string;
}

function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);

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
        </div>
      ) : (
        <Login />
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
