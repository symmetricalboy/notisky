import { useState, useEffect } from 'react';

function Options() {
  const [showNotificationContent, setShowNotificationContent] = useState(true);
  
  useEffect(() => {
    // Load settings from storage
    browser.storage.local.get(['settings']).then((result) => {
      if (result.settings) {
        if (result.settings.showNotificationContent !== undefined) {
          setShowNotificationContent(result.settings.showNotificationContent);
        }
      }
    });
  }, []);
  
  const handleSave = () => {
    // Save settings to storage
    browser.storage.local.set({
      settings: {
        showNotificationContent,
      }
    }).then(() => {
      // Show success message
      const status = document.getElementById('status');
      if (status) {
        status.textContent = 'Options saved.';
        setTimeout(() => {
          status.textContent = '';
        }, 2000);
      }
    });
  };
  
  return (
    <div className="options-container">
      <h1>Notisky Settings</h1>
      
      <div className="option-group">
        <label htmlFor="showNotificationContent">
          Show Notification Content:
        </label>
        <input
          type="checkbox"
          id="showNotificationContent"
          checked={showNotificationContent}
          onChange={(e) => setShowNotificationContent(e.target.checked)}
        />
        <p className="help-text">
          If disabled, notifications will only show "New notification from Bluesky"
          without displaying the actual content.
        </p>
      </div>
      
      <button onClick={handleSave}>Save Options</button>
      <div id="status" className="status"></div>
    </div>
  );
}

export default Options; 