/**
 * EV Companion PWA - Main Application
 * Handles auth, WebSocket chat, EV status, offline support
 */

class EVCompanion {
    constructor() {
        this.apiUrl = window.location.origin;
        this.ws = null;
        this.token = localStorage.getItem('ev_token');
        this.user = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 2000;
        this.messageQueue = [];
        this.isTyping = false;

        this.init();
    }

    init() {
        this.cacheElements();
        this.bindEvents();
        this.registerServiceWorker();

        // Check auth state
        if (this.token) {
            this.validateToken();
        }
    }

    cacheElements() {
        // Auth
        this.authScreen = document.getElementById('auth-screen');
        this.mainScreen = document.getElementById('main-screen');
        this.loginForm = document.getElementById('login-form');
        this.signupForm = document.getElementById('signup-form');
        this.authTabs = document.querySelectorAll('.auth-tab');
        this.authError = document.getElementById('auth-error');

        // Chat
        this.chatContainer = document.getElementById('chat-container');
        this.messagesList = document.getElementById('messages-list');
        this.messageInput = document.getElementById('message-input');
        this.sendBtn = document.getElementById('send-btn');
        this.welcomeMessage = document.getElementById('welcome-message');

        // EV Status
        this.evBattery = document.getElementById('ev-battery');
        this.evRange = document.getElementById('ev-range');
        this.evCharging = document.getElementById('ev-charging');
        this.evOdometer = document.getElementById('ev-odometer');
        this.evChargeIcon = document.getElementById('ev-charge-icon');

        // UI
        this.connectionStatus = document.getElementById('connection-status');
        this.logoutBtn = document.getElementById('logout-btn');
        this.toastContainer = document.getElementById('toast-container');
        this.installPrompt = document.getElementById('install-prompt');
        this.installBtn = document.getElementById('install-btn');
        this.dismissInstall = document.getElementById('dismiss-install');
    }

    bindEvents() {
        // Auth tabs
        this.authTabs.forEach(tab => {
            tab.addEventListener('click', () => this.switchAuthTab(tab.dataset.tab));
        });

        // Forms
        this.loginForm.addEventListener('submit', (e) => this.handleLogin(e));
        this.signupForm.addEventListener('submit', (e) => this.handleSignup(e));

        // Chat
        this.sendBtn.addEventListener('click', () => this.sendMessage());
        this.messageInput.addEventListener('keydown', (e) => this.handleInputKeydown(e));
        this.messageInput.addEventListener('input', () => this.autoResizeInput());

        // Quick actions
        document.querySelectorAll('.quick-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.messageInput.value = btn.dataset.prompt;
                this.autoResizeInput();
                this.sendMessage();
            });
        });

        // Logout
        this.logoutBtn.addEventListener('click', () => this.logout());

        // Install
        this.installBtn.addEventListener('click', () => this.installPWA());
        this.dismissInstall.addEventListener('click', () => {
            this.installPrompt.classList.add('hidden');
            localStorage.setItem('install_dismissed', 'true');
        });

        // Handle beforeinstallprompt
        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            this.deferredPrompt = e;
            if (!localStorage.getItem('install_dismissed')) {
                setTimeout(() => {
                    this.installPrompt.classList.remove('hidden');
                }, 3000);
            }
        });

        // Visibility change (reconnect when tab becomes active)
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && this.token && !this.ws) {
                this.connectWebSocket();
            }
        });
    }

    // ===== AUTH =====

    switchAuthTab(tab) {
        this.authTabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
        document.querySelectorAll('.auth-form').forEach(f => {
            f.classList.toggle('active', f.id === `${tab}-form`);
        });
        this.authError.classList.add('hidden');
    }

    async handleLogin(e) {
        e.preventDefault();
        const username = document.getElementById('login-username').value.trim();
        const password = document.getElementById('login-password').value;

        await this.authenticate('/auth/login', { username, password });
    }

    async handleSignup(e) {
        e.preventDefault();
        const username = document.getElementById('signup-username').value.trim();
        const password = document.getElementById('signup-password').value;

        if (password.length < 6) {
            this.showAuthError('Password must be at least 6 characters');
            return;
        }

        await this.authenticate('/auth/signup', { username, password });
    }

    async authenticate(endpoint, data) {
        const btn = document.querySelector('.auth-form.active .btn-primary');
        const loader = btn.querySelector('.btn-loader');
        const text = btn.querySelector('.btn-text');

        btn.disabled = true;
        loader.classList.remove('hidden');
        text.classList.add('hidden');
        this.authError.classList.add('hidden');

        try {
            const res = await fetch(`${this.apiUrl}${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });

            const result = await res.json();

            if (!res.ok) {
                throw new Error(result.detail || 'Authentication failed');
            }

            this.token = result.access_token;
            localStorage.setItem('ev_token', this.token);
            this.enterApp();

        } catch (err) {
            this.showAuthError(err.message);
        } finally {
            btn.disabled = false;
            loader.classList.add('hidden');
            text.classList.remove('hidden');
        }
    }

    showAuthError(msg) {
        this.authError.textContent = msg;
        this.authError.classList.remove('hidden');
    }

    async validateToken() {
        try {
            const res = await fetch(`${this.apiUrl}/auth/me`, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });

            if (res.ok) {
                this.user = await res.json();
                this.enterApp();
            } else {
                this.logout();
            }
        } catch {
            this.logout();
        }
    }

    enterApp() {
        this.authScreen.classList.remove('active');
        this.mainScreen.classList.add('active');
        this.loadChatHistory();
        this.loadEVStatus();
        this.connectWebSocket();
    }

    logout() {
        this.token = null;
        this.user = null;
        localStorage.removeItem('ev_token');

        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }

        this.messagesList.innerHTML = '';
        this.welcomeMessage.classList.remove('hidden');
        this.mainScreen.classList.remove('active');
        this.authScreen.classList.add('active');
        this.switchAuthTab('login');
    }

    // ===== WEBSOCKET =====

    connectWebSocket() {
        if (this.ws?.readyState === WebSocket.OPEN) return;

        const wsUrl = this.apiUrl.replace(/^http/, 'ws');
        this.ws = new WebSocket(`${wsUrl}/chat/ws`);

        this.ws.onopen = () => {
            console.log('WebSocket connected');
            this.reconnectAttempts = 0;
            this.updateConnectionStatus('connected');

            // Authenticate
            this.ws.send(JSON.stringify({
                type: 'auth',
                token: this.token
            }));

            // Flush queued messages
            while (this.messageQueue.length > 0) {
                const msg = this.messageQueue.shift();
                this.ws.send(JSON.stringify(msg));
            }
        };

        this.ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            this.handleWebSocketMessage(data);
        };

        this.ws.onclose = () => {
            console.log('WebSocket disconnected');
            this.ws = null;
            this.updateConnectionStatus('disconnected');

            if (this.reconnectAttempts < this.maxReconnectAttempts) {
                this.reconnectAttempts++;
                setTimeout(() => this.connectWebSocket(), this.reconnectDelay * this.reconnectAttempts);
            }
        };

        this.ws.onerror = (err) => {
            console.error('WebSocket error:', err);
        };
    }

    handleWebSocketMessage(data) {
        switch (data.type) {
            case 'connected':
                this.showToast('Connected', 'success');
                break;

            case 'message':
                this.removeTypingIndicator();
                this.isTyping = false;
                this.addMessage(data.data);
                break;

            case 'ev_update':
                this.updateEVDisplay(data.data);
                break;

            default:
                console.log('Unknown message type:', data.type);
        }
    }

    updateConnectionStatus(status) {
        this.connectionStatus.className = 'connection-status';
        const dot = this.connectionStatus.querySelector('.status-dot');
        const text = this.connectionStatus.querySelector('.status-text');

        if (status === 'connected') {
            this.connectionStatus.classList.add('connected');
            text.textContent = 'Online';
        } else if (status === 'disconnected') {
            this.connectionStatus.classList.add('disconnected');
            text.textContent = 'Offline';
        } else {
            text.textContent = 'Connecting...';
        }
    }

    // ===== CHAT =====

    async loadChatHistory() {
        try {
            const res = await fetch(`${this.apiUrl}/chat/history`, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });

            if (!res.ok) return;

            const data = await res.json();

            if (data.messages.length > 0) {
                this.welcomeMessage.classList.add('hidden');
                data.messages.forEach(msg => this.addMessage(msg));
            }
        } catch (err) {
            console.error('Failed to load history:', err);
        }
    }

    sendMessage() {
        const content = this.messageInput.value.trim();
        if (!content || this.isTyping) return;

        // Clear input
        this.messageInput.value = '';
        this.autoResizeInput();
        this.welcomeMessage.classList.add('hidden');

        // Show typing indicator
        this.isTyping = true;
        this.showTypingIndicator();

        // Send via WebSocket
        const msg = {
            type: 'chat',
            content: content
        };

        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        } else {
            this.messageQueue.push(msg);
            this.connectWebSocket();
        }
    }

    addMessage(msg) {
        const div = document.createElement('div');
        div.className = `message ${msg.role}`;
        div.dataset.id = msg.id;

        const avatar = msg.role === 'user' ? '👤' : '🤖';
        const time = new Date(msg.created_at).toLocaleTimeString([], { 
            hour: '2-digit', 
            minute: '2-digit' 
        });

        // Format message content (basic markdown)
        let formattedContent = this.formatMessage(msg.content);

        div.innerHTML = `
            <div class="message-avatar">${avatar}</div>
            <div class="message-content">
                <div class="message-text">${formattedContent}</div>
                <div class="message-time">${time}</div>
            </div>
        `;

        this.messagesList.appendChild(div);
        this.scrollToBottom();
    }

    formatMessage(text) {
        // Escape HTML
        text = text.replace(/&/g, '&amp;')
                   .replace(/</g, '&lt;')
                   .replace(/>/g, '&gt;');

        // Bold
        text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

        // Italic
        text = text.replace(/\*(.*?)\*/g, '<em>$1</em>');

        // Code blocks
        text = text.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');

        // Inline code
        text = text.replace(/`([^`]+)`/g, '<code>$1</code>');

        // Line breaks
        text = text.replace(/\n/g, '<br>');

        return text;
    }

    showTypingIndicator() {
        const div = document.createElement('div');
        div.className = 'message assistant typing';
        div.id = 'typing-indicator';
        div.innerHTML = `
            <div class="message-avatar">🤖</div>
            <div class="message-content">
                <div class="typing-indicator">
                    <span></span>
                    <span></span>
                    <span></span>
                </div>
            </div>
        `;
        this.messagesList.appendChild(div);
        this.scrollToBottom();
    }

    removeTypingIndicator() {
        const indicator = document.getElementById('typing-indicator');
        if (indicator) indicator.remove();
    }

    scrollToBottom() {
        this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
    }

    handleInputKeydown(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            this.sendMessage();
        }
    }

    autoResizeInput() {
        this.messageInput.style.height = 'auto';
        this.messageInput.style.height = Math.min(this.messageInput.scrollHeight, 120) + 'px';
        this.sendBtn.disabled = !this.messageInput.value.trim();
    }

    // ===== EV STATUS =====

    async loadEVStatus() {
        try {
            const res = await fetch(`${this.apiUrl}/chat/ev-status`, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });

            if (!res.ok) return;

            const data = await res.json();
            this.updateEVDisplay(data);
        } catch (err) {
            console.error('Failed to load EV status:', err);
        }
    }

    updateEVDisplay(data) {
        this.evBattery.textContent = `${data.battery_level}%`;
        this.evRange.textContent = `${data.range_km} km`;
        this.evCharging.textContent = data.charging ? 'Charging' : 'Idle';
        this.evOdometer.textContent = `${data.odometer_km} km`;

        this.evChargeIcon.textContent = data.charging ? '🔌' : '⚡';

        // Color coding for battery
        const batteryEl = this.evBattery.parentElement.parentElement;
        batteryEl.style.borderLeft = `3px solid ${this.getBatteryColor(data.battery_level)}`;
    }

    getBatteryColor(level) {
        if (level > 60) return '#10b981';
        if (level > 30) return '#f59e0b';
        return '#ef4444';
    }

    // ===== PWA =====

    registerServiceWorker() {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/static/js/sw.js')
                .then(reg => console.log('Service Worker registered'))
                .catch(err => console.log('Service Worker failed:', err));
        }
    }

    async installPWA() {
        if (!this.deferredPrompt) return;

        this.deferredPrompt.prompt();
        const { outcome } = await this.deferredPrompt.userChoice;

        if (outcome === 'accepted') {
            this.showToast('EV Companion installed!', 'success');
        }

        this.deferredPrompt = null;
        this.installPrompt.classList.add('hidden');
    }

    // ===== UTILITIES =====

    showToast(message, type = 'info', duration = 3000) {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;

        this.toastContainer.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'toastSlide 0.3s ease reverse';
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.app = new EVCompanion();
});
