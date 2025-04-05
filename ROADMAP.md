# Notisky Browser Extension Roadmap

## Project Overview

Notisky is a browser extension that enhances the Bluesky experience by providing real-time notifications, multi-account support, and improved UI features. Built with the WXT framework, it will be compatible with Chromium browsers, Firefox, and Safari under the Manifest V3 standard.

### Key Features
- Multi-account authentication via Bluesky's OAuth flow
- Real-time notifications and messages polling (every 1000ms)
- Desktop notifications with customizable content settings
- Favicon and extension icon badges with notification counters
- DOM modifications for improved notification display in the Bluesky web app
- Cross-account notification counter next to the account switcher

## Phase 1: Project Setup and Infrastructure (Week 1)

### 1.1 Development Environment Setup
- [ ] Set up the WXT development environment
- [ ] Configure TypeScript, ESLint, and Prettier
- [ ] Set up testing framework (Jest/Vitest)
- [ ] Configure build process for different browser targets

### 1.2 Project Structure
- [ ] Define the extension architecture
- [ ] Create modular folder structure
- [ ] Set up state management approach
- [ ] Establish coding standards and documentation guidelines

### 1.3 Dependencies
- [ ] Integrate ATProto client libraries
- [ ] Set up necessary APIs for Bluesky interaction
- [ ] Research and integrate notification libraries if needed
- [ ] Set up secure storage mechanisms for credentials

## Phase 2: Authentication Implementation (Week 2)

### 2.1 OAuth Flow
- [ ] Implement Bluesky OAuth flow
- [ ] Create login UI for the extension
- [ ] Set up secure token storage
- [ ] Implement token refresh mechanism
- [ ] Add multi-account support

### 2.2 Account Management
- [ ] Create account management UI
- [ ] Implement account switching functionality
- [ ] Build account persistence between browser sessions
- [ ] Add account removal capability

## Phase 3: Service Worker Architecture (Weeks 3-4)

### 3.1 Core Service Worker
- [ ] Implement the primary extension service worker
- [ ] Set up communication channels between service workers and UI
- [ ] Implement lifecycle management for service workers

### 3.2 Per-Account Service Workers
- [ ] Develop architecture for per-account service workers
- [ ] Set up isolated contexts for each account
- [ ] Implement activation/deactivation based on account status

### 3.3 Polling System
- [ ] Create efficient polling system for notifications (1000ms interval)
- [ ] Implement intelligent polling with backoff for error conditions
- [ ] Build data caching layer to minimize redundant requests
- [ ] Add configurable polling intervals in settings

## Phase 4: Notification System (Weeks 5-6)

### 4.1 Notification Fetching
- [ ] Implement Bluesky API calls for notification data
- [ ] Create differential update system to track new notifications
- [ ] Add message-specific API handling
- [ ] Implement data normalization for consistent processing

### 4.2 Desktop Notifications
- [ ] Create desktop notification system
- [ ] Implement customizable notification content
- [ ] Add notification grouping for multiple updates
- [ ] Create click handlers to navigate to relevant content

### 4.3 Badge System
- [ ] Implement counter badges for the extension icon
- [ ] Create favicon badge modification for bsky.app
- [ ] Add unread counts tracking across accounts
- [ ] Implement badge clearing on notification view

## Phase 5: UI Modifications (Weeks 7-8)

### 5.1 DOM Injection
- [ ] Develop safe DOM modification system
- [ ] Create mutation observers to track Bluesky app changes
- [ ] Implement reliable selectors for DOM elements
- [ ] Add fail-safes for when page structure changes

### 5.2 Enhanced UI Elements
- [ ] Add cross-account notification counter to account switcher
- [ ] Implement accurate notification counts in Bluesky tabs
- [ ] Create refresh mechanism for notifications/messages when tab is viewed
- [ ] Add visual indicators for real-time updates

### 5.3 Extension UI
- [ ] Design and implement the extension popup UI
- [ ] Create settings panel
- [ ] Add account switcher in the extension
- [ ] Implement notification preview in extension popup

## Phase 6: Settings and Customization (Week 9)

### 6.1 User Preferences
- [ ] Create settings storage system
- [ ] Implement notification content visibility options
- [ ] Add polling frequency controls
- [ ] Include UI modification toggles

### 6.2 Appearance Options
- [ ] Implement theme settings (light/dark/system)
- [ ] Add custom badge styling options
- [ ] Create notification appearance settings

## Phase 7: Testing and Optimization (Weeks 10-11)

### 7.1 Unit and Integration Testing
- [ ] Develop test suite for core functionality
- [ ] Create mocks for Bluesky API
- [ ] Implement E2E tests for critical user flows
- [ ] Set up continuous integration for automated testing

### 7.2 Performance Optimization
- [ ] Audit and optimize polling performance
- [ ] Minimize DOM operation overhead
- [ ] Reduce extension memory footprint
- [ ] Optimize startup time

### 7.3 Cross-Browser Testing
- [ ] Test on Chrome/Chromium
- [ ] Test on Firefox
- [ ] Test on Safari
- [ ] Fix browser-specific issues

## Phase 8: Deployment and Distribution (Week 12)

### 8.1 Packaging
- [ ] Create production builds for each browser
- [ ] Implement version management
- [ ] Prepare store assets (icons, screenshots, descriptions)

### 8.2 Store Submissions
- [ ] Submit to Chrome Web Store
- [ ] Submit to Firefox Add-ons
- [ ] Submit to Safari Extensions Gallery
- [ ] Address review feedback

### 8.3 Documentation
- [ ] Create user documentation
- [ ] Write developer documentation
- [ ] Prepare contribution guidelines
- [ ] Create support resources

## Phase 9: Post-Launch and Maintenance

### 9.1 User Feedback
- [ ] Set up feedback channels
- [ ] Create issue templates for bug reports
- [ ] Develop process for feature requests

### 9.2 Ongoing Development
- [ ] Plan feature enhancements
- [ ] Monitor Bluesky API changes
- [ ] Respond to browser platform updates
- [ ] Regular security audits

## Timeline and Milestones

| Milestone | Target Date | Description |
|-----------|-------------|-------------|
| Alpha Release | End of Week 6 | Basic functionality with auth and notifications |
| Beta Release | End of Week 10 | Complete features with UI enhancements |
| 1.0 Release | End of Week 12 | Full production release to extension stores |
| Maintenance Releases | Ongoing | Bi-weekly updates following launch |

## Technical Considerations

### ATProto Integration
- Use the official ATProto client libraries
- Maintain compatibility with API changes
- Follow Bluesky's rate limiting guidelines
- Implement proper error handling for API responses

### Security Considerations
- Secure storage of authentication tokens
- Privacy-focused design for user data
- Clear permission scope declarations
- Regular security audits

### Performance Goals
- Sub-second response for notification updates
- Minimal CPU/memory impact for background workers
- Efficient DOM modifications to prevent page slowdowns
- Battery-conscious polling on mobile devices

## Potential Challenges and Mitigations

| Challenge | Mitigation Strategy |
|-----------|---------------------|
| Bluesky API Changes | Monitoring API endpoints and quick response to changes |
| Browser Platform Differences | Abstraction layers and browser-specific adaptations |
| Performance Impact | Optimized polling and caching strategies |
| OAuth Security | Following best practices for token handling |
| DOM Structure Changes | Robust selectors and fallback mechanisms |

This roadmap will be periodically reviewed and adjusted as development progresses and additional insights are gained.
