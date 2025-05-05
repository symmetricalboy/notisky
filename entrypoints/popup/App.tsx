import { useState, useEffect } from 'react';
import './App.css'; // Use App.css instead of Popup.css
import { Account } from '../../src/services/auth'; // Import Account type

// Interface for account data including counts
interface AccountWithCounts extends Account {
  notificationCount: number;
  messageCount: number;
}

// Interface for simplified notification data for the popup
interface SimpleNotification {
  cid: string;
  uri: string;
  reason: string;
  isRead: boolean;
  indexedAt: string;
  authorHandle?: string;
  authorAvatar?: string;
}

// Renamed function to App
function App() { 
  const [accounts, setAccounts] = useState<AccountWithCounts[]>([]);
  const [selectedDid, setSelectedDid] = useState<string | null>(null);
  const [recentNotifications, setRecentNotifications] = useState<SimpleNotification[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch initial data
  useEffect(() => {
    const fetchData = async () => {
      setIsLoading(true);
      setError(null);
      try {
        // Use the correct message type
        const response = await browser.runtime.sendMessage({ type: 'GET_ACCOUNTS_AND_COUNTS' }); 
        if (response && response.success && Array.isArray(response.accounts)) {
          setAccounts(response.accounts);
          // Select the first account by default if available
          if (response.accounts.length > 0) {
            const firstDid = response.accounts[0].did;
            setSelectedDid(firstDid);
            // Fetch recent notifications for the initially selected account
            fetchRecentNotifications(firstDid);
          } else {
            setIsLoading(false); // No accounts, stop loading
          }
        } else {
          throw new Error(response?.error || 'Failed to fetch accounts');
        }
      } catch (err) {
        console.error("Error fetching initial data:", err);
        setError(err instanceof Error ? err.message : String(err));
        setIsLoading(false);
      }
    };
    fetchData();

    // Listener for updates from background
    const messageListener = (message: any) => {
      if (message.type === 'NOTIFICATION_COUNT_UPDATED') {
        setAccounts(prev => prev.map(acc => 
          acc.did === message.data.did ? { ...acc, notificationCount: message.data.count } : acc
        ));
      }
      if (message.type === 'MESSAGE_COUNT_UPDATED') {
        setAccounts(prev => prev.map(acc => 
          acc.did === message.data.did ? { ...acc, messageCount: message.data.count } : acc
        ));
      }
      // Potentially add listener for RECENT_NOTIFICATIONS_UPDATED if needed
    };
    browser.runtime.onMessage.addListener(messageListener);

    // Cleanup listener on unmount
    return () => {
      browser.runtime.onMessage.removeListener(messageListener);
    };
  }, []);

  // Fetch recent notifications when selected account changes
  useEffect(() => {
    if (selectedDid) {
      fetchRecentNotifications(selectedDid);
    }
  }, [selectedDid]);

  const fetchRecentNotifications = async (did: string) => {
    setIsLoading(true); // Indicate loading notifications
    try {
      const response = await browser.runtime.sendMessage({ 
        type: 'GET_RECENT_NOTIFICATIONS',
        data: { did }
      });
      if (response && response.success && Array.isArray(response.notifications)) {
        setRecentNotifications(response.notifications);
      } else {
        console.warn('Failed to fetch recent notifications:', response?.error);
        setRecentNotifications([]); // Clear notifications on failure
      }
    } catch (err) {
      console.error(`Error fetching recent notifications for ${did}:`, err);
      setRecentNotifications([]); // Clear notifications on error
    } finally {
      setIsLoading(false); // Finished loading notifications
    }
  };

  const handleAccountChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedDid(event.target.value);
  };

  const handleOpenOptions = () => {
    browser.runtime.sendMessage({ type: 'OPEN_OPTIONS_PAGE' });
  };
  
  // --- NEW: Function to open login page ---
  const handleAddAccount = () => {
    const loginUrl = browser.runtime.getURL("/login.html");
    browser.tabs.create({ url: loginUrl, active: true });
    window.close(); // Close popup after opening login tab
  };
  // ----------------------------------------

  const handleOpenLink = (url: string) => {
    browser.tabs.create({ url });
  };

  const selectedAccount = accounts.find(acc => acc.did === selectedDid);

  // Helper to format notification text
  const formatNotificationText = (notif: SimpleNotification): string => {
    const handle = notif.authorHandle ? `@${notif.authorHandle}` : 'Someone';
    switch (notif.reason) {
      case 'like': return `${handle} liked your post`;
      case 'repost': return `${handle} reposted your post`;
      case 'follow': return `${handle} followed you`;
      case 'mention': return `${handle} mentioned you`;
      case 'reply': return `${handle} replied to your post`;
      case 'quote': return `${handle} quoted your post`;
      default: return `New notification (${notif.reason})`;
    }
  };

  return (
    <div className="popup-container">
      <header>
        <h1>Notisky</h1>
        <button onClick={handleAddAccount} className="add-account-button" title="Add Account">➕</button>
        <button onClick={handleOpenOptions} className="options-button" title="Open Settings">⚙️</button>
      </header>

      {error && <p className="error-message">Error: {error}</p>}

      {accounts.length > 0 ? (
        <div className="account-section">
          <select onChange={handleAccountChange} value={selectedDid || ''} aria-label="Select Account">
            {accounts.map(acc => (
              <option key={acc.did} value={acc.did}>
                @{acc.handle}
              </option>
            ))}
          </select>

          {selectedAccount && (
            <div className="counts-section">
              <button onClick={() => handleOpenLink('https://bsky.app/notifications')} className="count-link">
                Notifications: <span className="count">{selectedAccount.notificationCount}</span>
              </button>
              <button onClick={() => handleOpenLink('https://bsky.app/messages')} className="count-link">
                 Messages: <span className="count">{selectedAccount.messageCount}</span>
              </button>
            </div>
          )}
        </div>
      ) : (
        !isLoading && <p>No accounts logged in. Please log in via the options page.</p>
      )}

      <div className="notifications-log">
        <h2>Recent Notifications</h2>
        {isLoading && !error && <p>Loading...</p>}
        {!isLoading && recentNotifications.length > 0 && (
          <ul>
            {recentNotifications.map(notif => (
              <li key={notif.cid} className={notif.isRead ? 'read' : 'unread'}>
                {/* Basic display, could add avatar, timestamp, link later */}
                <span>{formatNotificationText(notif)}</span>
                {/* Example link (needs construction based on URI/reason) 
                <button onClick={() => handleOpenLink(`https://bsky.app/profile/${notif.authorHandle}/post/${notif.uri?.split('/').pop()}`)}>View</button> 
                */}
              </li>
            ))}
          </ul>
        )}
        {!isLoading && recentNotifications.length === 0 && selectedAccount && (
          <p>No recent notifications found for @{selectedAccount.handle}.</p>
        )}
      </div>
    </div>
  );
}

export default App; // Export App as default
