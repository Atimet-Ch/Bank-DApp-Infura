import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ethers } from 'ethers';
import { infuraProvider, INFURA_CONFIGURED } from './infura.js';

const TARGET_CHAIN_ID = 560048;
const TARGET_CHAIN_HEX = '0x88bb0';
const CONNECT_TIMEOUT_MS = 45000;
const TOAST_DURATION_MS = 6000;
const HISTORY_LIMIT = 100;
const EXPLORER_TX_URL = 'https://hoodi.etherscan.io/tx/';

const config = window.__QUICK_DAPP_CONFIG__ || {};
const configuredContracts = Array.isArray(config.contracts) ? config.contracts : [];
const primaryBinding = configuredContracts.find((contract) => contract.id === config.primaryContractId);
const bankBinding = configuredContracts.find((c) => String(c.alias || '').toLowerCase() === 'bank') || primaryBinding;
const bindingIsValid = Boolean(
  primaryBinding &&
  bankBinding &&
  bankBinding.id === primaryBinding.id &&
  ethers.isAddress(bankBinding.address) &&
  Array.isArray(bankBinding.abi) &&
  bankBinding.abi.length > 0
);

function withTimeout(promise, milliseconds, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer));
}

function shortenAddress(address) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '';
}

function formatEtherDisplay(value) {
  try {
    const formatted = ethers.formatEther(value || 0);
    const [whole, decimals = ''] = formatted.split('.');
    const trimmed = decimals.replace(/0+$/, '').slice(0, 6);
    return `${Number(whole).toLocaleString('en-US')}${trimmed ? `.${trimmed}` : ''}`;
  } catch {
    return '0';
  }
}

function friendlyError(error) {
  const message = error?.shortMessage || error?.info?.error?.message || error?.message || 'Something went wrong. Please try again.';
  if (error?.code === 4001 || error?.code === 'ACTION_REJECTED' || /user rejected|denied/i.test(message)) {
    return 'The request was cancelled in your wallet.';
  }
  if (error?.code === 49002 || /unrecognized chain|not been added/i.test(message)) {
    return 'Add chain 560048 to your wallet, then try switching again.';
  }
  if (/insufficient funds/i.test(message)) return 'Your wallet does not have enough ETH to cover this transaction and gas.';
  if (/missing revert data|execution reverted|require\(false\)|CALL_EXCEPTION/i.test(message)) {
    return 'The contract could not complete this transaction. Check the amount and your available balance.';
  }
  return message.length > 180 ? `${message.slice(0, 177)}…` : message;
}

function viewFromHash() {
  return window.location.hash === '#activity' ? 'activity' : 'overview';
}

function historyKey(account, chainId) {
  return account && chainId ? `qdapp_bank_history_${chainId}_${account.toLowerCase()}` : '';
}

function readHistory(key) {
  if (!key) return [];
  try {
    const stored = JSON.parse(localStorage.getItem(key) || '[]');
    if (!Array.isArray(stored)) return [];
    return stored.filter((item) => item && item.id && ['deposit', 'withdraw'].includes(item.action)).slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function WalletIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 6.5h14.5A1.5 1.5 0 0 1 20 8v10a2 2 0 0 1-2 2H5a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M15 11h6v5h-6a2.5 2.5 0 0 1 0-5Z" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="16" cy="13.5" r=".8" fill="currentColor" />
    </svg>
  );
}

function ArrowIcon({ direction = 'down', size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ transform: direction === 'up' ? 'rotate(180deg)' : undefined }}>
      <path d="M12 4v15m0 0 6-6m-6 6-6-6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RefreshIcon({ spinning = false }) {
  return (
    <svg className={spinning ? 'spin' : ''} width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M20 7v5h-5M4 17v-5h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.1 8.3A7 7 0 0 1 18.7 7L20 12M4 12l1.3 5a7 7 0 0 0 12.6-1.3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function ToastIcon({ type }) {
  if (type === 'pending') return <span className="button-loader" />;
  return <span className="toast-symbol">{type === 'success' ? '✓' : type === 'error' ? '!' : 'i'}</span>;
}

function App() {
  const appTitle = config.title || 'My DApp';
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [account, setAccount] = useState('');
  const [chainId, setChainId] = useState(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [walletError, setWalletError] = useState('');
  const [balance, setBalance] = useState(0n);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [action, setAction] = useState('deposit');
  const [amount, setAmount] = useState('');
  const [transaction, setTransaction] = useState(null);
  const [activity, setActivity] = useState([]);
  const [activeView, setActiveView] = useState(viewFromHash);
  const [toasts, setToasts] = useState([]);
  const rawProviderRef = useRef(null);
  const listenersRef = useRef(null);
  const toastTimersRef = useRef(new Map());
  const toastIdRef = useRef(0);
  const loadedHistoryKeyRef = useRef('');

  const isConnected = Boolean(account && provider && signer);
  const isCorrectNetwork = chainId === TARGET_CHAIN_ID;
  const currentHistoryKey = historyKey(account, chainId);

  const contract = useMemo(() => {
    if (!bindingIsValid || !provider || !isCorrectNetwork || !signer) return null;
    return new ethers.Contract(bankBinding.address, bankBinding.abi, signer);
  }, [provider, signer, isCorrectNetwork]);

  const dismissToast = useCallback((id) => {
    const timer = toastTimersRef.current.get(id);
    if (timer) window.clearTimeout(timer);
    toastTimersRef.current.delete(id);
    setToasts((items) => items.filter((item) => item.id !== id));
  }, []);

  const notify = useCallback(({ type = 'info', title, message, hash = '' }) => {
    toastIdRef.current += 1;
    const id = `${Date.now()}-${toastIdRef.current}`;
    setToasts((items) => [...items.slice(-4), { id, type, title, message, hash }]);
    const timer = window.setTimeout(() => {
      toastTimersRef.current.delete(id);
      setToasts((items) => items.filter((item) => item.id !== id));
    }, TOAST_DURATION_MS);
    toastTimersRef.current.set(id, timer);
    return id;
  }, []);

  useEffect(() => () => {
    toastTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    toastTimersRef.current.clear();
  }, []);

  useEffect(() => {
    const handleHashChange = () => setActiveView(viewFromHash());
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  useEffect(() => {
    loadedHistoryKeyRef.current = currentHistoryKey;
    setActivity(readHistory(currentHistoryKey));
  }, [currentHistoryKey]);

  useEffect(() => {
    if (!currentHistoryKey || loadedHistoryKeyRef.current !== currentHistoryKey) return;
    try {
      localStorage.setItem(currentHistoryKey, JSON.stringify(activity));
    } catch {
      // History remains available in memory when storage is restricted.
    }
  }, [activity, currentHistoryKey]);

  const updateHistory = useCallback((id, updates) => {
    setActivity((items) => items.map((item) => item.id === id ? { ...item, ...updates } : item));
  }, []);

  const removeProviderListeners = useCallback(() => {
    const listeners = listenersRef.current;
    if (listeners?.rawProvider?.removeListener) {
      listeners.rawProvider.removeListener('accountsChanged', listeners.accountsChanged);
      listeners.rawProvider.removeListener('chainChanged', listeners.chainChanged);
    }
    listenersRef.current = null;
  }, []);

  const clearSession = useCallback(() => {
    removeProviderListeners();
    rawProviderRef.current = null;
    setProvider(null);
    setSigner(null);
    setAccount('');
    setChainId(null);
    setBalance(0n);
    setTransaction(null);
    setActivity([]);
    loadedHistoryKeyRef.current = '';
  }, [removeProviderListeners]);

  const handleAccountsChanged = useCallback(async (accounts) => {
    if (!Array.isArray(accounts) || accounts.length === 0) {
      clearSession();
      notify({ type: 'info', title: 'Wallet disconnected', message: 'Your wallet session has ended.' });
      return;
    }
    try {
      const rawProvider = rawProviderRef.current;
      if (!rawProvider) return;
      const nextProvider = new ethers.BrowserProvider(rawProvider);
      const nextSigner = await nextProvider.getSigner();
      setActivity([]);
      setProvider(nextProvider);
      setSigner(nextSigner);
      setAccount(accounts[0]);
      setTransaction(null);
      setWalletError('');
      notify({ type: 'success', title: 'Account changed', message: `Connected to ${shortenAddress(accounts[0])}.` });
    } catch (error) {
      const message = friendlyError(error);
      setWalletError(message);
      notify({ type: 'error', title: 'Account update failed', message });
    }
  }, [clearSession, notify]);

  const handleChainChanged = useCallback(async (nextChainId) => {
    try {
      const decimalChainId = Number(BigInt(nextChainId));
      const rawProvider = rawProviderRef.current;
      if (!rawProvider) return;
      const nextProvider = new ethers.BrowserProvider(rawProvider);
      const nextSigner = await nextProvider.getSigner();
      setActivity([]);
      setProvider(nextProvider);
      setSigner(nextSigner);
      setChainId(decimalChainId);
      setBalance(0n);
      setTransaction(null);
      setWalletError('');
      notify({
        type: decimalChainId === TARGET_CHAIN_ID ? 'success' : 'info',
        title: 'Network changed',
        message: decimalChainId === TARGET_CHAIN_ID ? 'Connected to Ethereum Hoodi.' : `Wallet switched to chain ${decimalChainId}.`,
      });
    } catch (error) {
      const message = friendlyError(error);
      setWalletError(message);
      notify({ type: 'error', title: 'Network update failed', message });
    }
  }, [notify]);

  useEffect(() => () => removeProviderListeners(), [removeProviderListeners]);

  const connectWallet = async () => {
    if (isConnecting) return;
    setIsConnecting(true);
    setWalletError('');
    setTransaction(null);
    try {
      const rawProvider = await withTimeout(
        Promise.resolve(window.__qdapp_getProvider ? window.__qdapp_getProvider() : window.ethereum),
        CONNECT_TIMEOUT_MS,
        'Wallet selection timed out. Unlock your wallet and try again.',
      );
      if (!rawProvider?.request) throw new Error('No compatible wallet was found. Install a browser wallet and try again.');
      console.info('[QDBinding] wallet.connect', { stage: 'provider-selected' });

      const accounts = await withTimeout(
        rawProvider.request({ method: 'eth_requestAccounts' }),
        CONNECT_TIMEOUT_MS,
        'Wallet authorization timed out. Open your wallet and retry the connection.',
      );
      if (!Array.isArray(accounts) || accounts.length === 0) throw new Error('No wallet account was authorized. Select an account and try again.');
      console.info('[QDBinding] wallet.connect', { stage: 'accounts-authorized' });

      const nextProvider = new ethers.BrowserProvider(rawProvider);
      const network = await nextProvider.getNetwork();
      const nextSigner = await nextProvider.getSigner();
      removeProviderListeners();
      rawProviderRef.current = rawProvider;
      rawProvider.on('accountsChanged', handleAccountsChanged);
      rawProvider.on('chainChanged', handleChainChanged);
      listenersRef.current = { rawProvider, accountsChanged: handleAccountsChanged, chainChanged: handleChainChanged };
      setProvider(nextProvider);
      setSigner(nextSigner);
      setAccount(accounts[0]);
      setChainId(Number(network.chainId));
      console.info('[QDBinding] wallet.connect', { stage: 'connected' });
      notify({ type: 'success', title: 'Wallet connected', message: `Connected as ${shortenAddress(accounts[0])}.` });
    } catch (error) {
      clearSession();
      const message = friendlyError(error);
      setWalletError(message);
      notify({ type: 'error', title: 'Connection failed', message });
    } finally {
      setIsConnecting(false);
    }
  };

  const disconnectWallet = () => {
    clearSession();
    setWalletError('');
    setActiveView('overview');
    if (window.location.hash !== '#overview') window.location.hash = 'overview';
    try {
      localStorage.removeItem('__qdapp_wallet_rdns');
    } catch {
      // Storage can be unavailable in privacy-restricted browser contexts.
    }
    notify({ type: 'success', title: 'Wallet disconnected', message: 'Your wallet session has been cleared.' });
  };

  const switchNetwork = async () => {
    const rawProvider = rawProviderRef.current;
    if (!rawProvider?.request || isSwitching) return;
    setIsSwitching(true);
    setWalletError('');
    try {
      await rawProvider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: TARGET_CHAIN_HEX }] });
    } catch (error) {
      const message = friendlyError(error);
      setWalletError(message);
      notify({ type: 'error', title: 'Network switch failed', message });
    } finally {
      setIsSwitching(false);
    }
  };

  const refreshBalance = useCallback(async () => {
    if (!contract || !account || !isCorrectNetwork) return;
    setIsRefreshing(true);
    try {
      if (!INFURA_CONFIGURED) throw new Error('Set VITE_INFURA_API_KEY in your .env file first.');
      // checkBlance() uses msg.sender, so preserve the connected wallet as eth_call.from.
      const data = contract.interface.encodeFunctionData('checkBlance');
      const result = await infuraProvider.call({ to: bankBinding.address, from: account, data });
      const [nextBalance] = contract.interface.decodeFunctionResult('checkBlance', result);
      setBalance(nextBalance);
    } catch (error) {
      const message = `Balance refresh failed: ${friendlyError(error)}`;
      setTransaction({ type: 'error', message });
      notify({ type: 'error', title: 'Could not refresh balance', message: friendlyError(error) });
    } finally {
      setIsRefreshing(false);
    }
  }, [contract, account, isCorrectNetwork, notify]);

  useEffect(() => {
    if (contract && account && isCorrectNetwork) refreshBalance();
  }, [contract, account, isCorrectNetwork, refreshBalance]);

  const submitTransaction = async (event) => {
    event.preventDefault();
    if (!contract || !isConnected || !isCorrectNetwork || transaction?.type === 'pending') return;
    setTransaction(null);
    let value;
    try {
      if (!amount || Number(amount) <= 0) throw new Error('Enter an amount greater than zero.');
      value = ethers.parseEther(amount);
      if (action === 'withdraw' && value > balance) throw new Error('The withdrawal amount is higher than your contract balance.');
    } catch (error) {
      const message = error.message || 'Enter a valid ETH amount.';
      setTransaction({ type: 'error', message });
      notify({ type: 'error', title: 'Check transaction details', message });
      return;
    }

    const submittedAction = action;
    const submittedAmount = amount;
    const historyId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = Date.now();
    setActivity((items) => [{
      id: historyId,
      action: submittedAction,
      amount: submittedAmount,
      hash: '',
      status: 'pending',
      createdAt,
    }, ...items].slice(0, HISTORY_LIMIT));
    setTransaction({ type: 'pending', message: `Confirm the ${submittedAction} in your wallet…` });
    notify({ type: 'pending', title: 'Confirm in your wallet', message: `Approve the ${submittedAction} of ${submittedAmount} ETH.` });

    let txHash = '';
    try {
      const tx = submittedAction === 'deposit' ? await contract.deposit({ value }) : await contract.withdraw(value);
      txHash = tx.hash;
      updateHistory(historyId, { hash: tx.hash, status: 'pending' });
      setTransaction({ type: 'pending', message: 'Transaction submitted. Waiting for confirmation…', hash: tx.hash });
      notify({ type: 'pending', title: 'Waiting for confirmation', message: `${submittedAction === 'deposit' ? 'Deposit' : 'Withdrawal'} submitted to Ethereum Hoodi.`, hash: tx.hash });
      await tx.wait();
      updateHistory(historyId, { hash: tx.hash, status: 'success', confirmedAt: Date.now() });
      setTransaction({ type: 'success', message: `${submittedAction === 'deposit' ? 'Deposit' : 'Withdrawal'} confirmed on-chain.`, hash: tx.hash });
      notify({ type: 'success', title: `${submittedAction === 'deposit' ? 'Deposit' : 'Withdrawal'} successful`, message: `${submittedAmount} ETH confirmed on-chain.`, hash: tx.hash });
      setAmount('');
      await refreshBalance();
    } catch (error) {
      const message = friendlyError(error);
      updateHistory(historyId, { hash: txHash, status: 'failed', failedAt: Date.now(), error: message });
      setTransaction({ type: 'error', message, hash: txHash });
      notify({ type: 'error', title: `${submittedAction === 'deposit' ? 'Deposit' : 'Withdrawal'} failed`, message, hash: txHash });
    }
  };

  const selectAction = (nextAction) => {
    if (transaction?.type === 'pending') return;
    setAction(nextAction);
    setAmount('');
    setTransaction(null);
  };

  const clearHistory = () => {
    setActivity([]);
    if (currentHistoryKey) {
      try {
        localStorage.removeItem(currentHistoryKey);
      } catch {
        // The in-memory history is still cleared.
      }
    }
    notify({ type: 'success', title: 'History cleared', message: 'Transaction history for this account has been removed.' });
  };

  const navigate = (view) => {
    setActiveView(view);
    if (window.location.hash !== `#${view}`) window.location.hash = view;
  };

  return (
    <div className="app-shell">
      <aside className="side-rail">
        <a className="brand-mark" href="#overview" onClick={() => setActiveView('overview')} aria-label={`${appTitle} home`}>
          <span className="brand-symbol"><span /></span>
          <span className="brand-name">{appTitle}</span>
        </a>
        <nav className="rail-nav" aria-label="Main navigation">
          <a href="#overview" onClick={() => setActiveView('overview')} className={`nav-item ${activeView === 'overview' ? 'active' : ''}`} aria-current={activeView === 'overview' ? 'page' : undefined}>
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 13h6V4H4v9Zm0 7h6v-4H4v4Zm10 0h6v-9h-6v9Zm0-16v4h6V4h-6Z" stroke="currentColor" strokeWidth="1.5" /></svg>
            <span>Overview</span>
          </a>
          <a href="#activity" onClick={() => setActiveView('activity')} className={`nav-item ${activeView === 'activity' ? 'active' : ''}`} aria-current={activeView === 'activity' ? 'page' : undefined}>
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 4v16M5 8h9a4 4 0 0 1 0 8H5m9-8 3-3m-3 3 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <span>Activity</span>
          </a>
        </nav>
        <div className="rail-foot">
          <span className={`network-dot ${isConnected && isCorrectNetwork ? 'online' : ''}`} />
          <span>{isConnected ? (isCorrectNetwork ? 'Network ready' : 'Wrong network') : 'Wallet offline'}</span>
          <span className="mono chain-label">ID {TARGET_CHAIN_ID}</span>
        </div>
      </aside>

      <main className="main-content" id="overview">
        <header className="topbar">
          <div>
            <p className="eyebrow">{activeView === 'activity' ? 'TRANSACTION LEDGER' : 'ON-CHAIN ACCOUNT'}</p>
            <h1>{activeView === 'activity' ? <>Your activity, <span>on record.</span></> : <>Your money, <span>your move.</span></>}</h1>
          </div>
          {!isConnected ? (
            <button className="wallet-button primary" onClick={connectWallet} disabled={isConnecting || !bindingIsValid}>
              <WalletIcon /> {isConnecting ? 'Connecting…' : 'Connect Wallet'}
            </button>
          ) : (
            <div className="wallet-controls">
              {isConnected && !isCorrectNetwork && (
                <button className="wallet-button warning" onClick={switchNetwork} disabled={isSwitching}>
                  {isSwitching ? 'Switching…' : 'Switch Network'}
                </button>
              )}
              <div className="account-chip" title={account}>
                <span className="account-identicon" />
                <span className="mono">{shortenAddress(account)}</span>
                <span className="connected-label"><i /> Connected</span>
              </div>
              <button className="disconnect-button" onClick={disconnectWallet}>Disconnect wallet</button>
            </div>
          )}
        </header>

        {!bindingIsValid && (
          <section className="notice error-notice" role="alert">
            <strong>Contract configuration unavailable</strong>
            <span>The Bank binding is missing or invalid. Reopen this DApp from its verified configuration.</span>
          </section>
        )}
        {walletError && <section className="notice error-notice" role="alert"><span>{walletError}</span><button onClick={() => setWalletError('')} aria-label="Dismiss error">×</button></section>}
        {isConnected && !isCorrectNetwork && (
          <section className="notice network-notice">
            <span>Your wallet is on chain {chainId ?? 'unknown'}. Switch to chain {TARGET_CHAIN_ID} to access your account.</span>
            <button onClick={switchNetwork} disabled={isSwitching}>{isSwitching ? 'Switching…' : 'Switch network →'}</button>
          </section>
        )}

        {activeView === 'overview' ? (
          <div className="dashboard-grid">
            <section className="balance-section">
              <div className="balance-card">
                <div className="card-topline">
                  <span>CONTRACT BALANCE</span>
                  <button className="icon-button" onClick={refreshBalance} disabled={!contract || isRefreshing} aria-label="Refresh balance" title="Refresh balance">
                    <RefreshIcon spinning={isRefreshing} />
                  </button>
                </div>
                <div className="balance-value">
                  <span className="balance-number">{isConnected && isCorrectNetwork ? formatEtherDisplay(balance) : '—'}</span>
                  <span className="balance-currency">ETH</span>
                </div>
                <div className="balance-caption">
                  {isConnected && isCorrectNetwork ? 'Available to withdraw from the Bank contract' : 'Connect to the correct network to view your balance'}
                </div>
                <div className="balance-visual" aria-hidden="true">
                  <div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="orbit orbit-three" />
                  <div className="visual-core"><span>Ξ</span></div>
                </div>
                <div className="contract-row">
                  <span><i className="status-pip" /> {bankBinding?.name || 'Contract'} vault</span>
                  <span className="mono">{bankBinding?.address ? shortenAddress(bankBinding.address) : 'Not configured'}</span>
                </div>
              </div>

              <div className="principles-row">
                <div><span className="principle-index">01</span><p><strong>Non-custodial</strong><br />Your wallet stays in control.</p></div>
                <div><span className="principle-index">02</span><p><strong>Direct settlement</strong><br />Every action is on-chain.</p></div>
              </div>
            </section>

            <section className="transaction-panel">
              <div className="panel-heading">
                <div><p className="eyebrow">MAKE A MOVE</p><h2>Manage funds</h2></div>
                <span className="secure-label"><span /> SECURE</span>
              </div>
              <div className="action-tabs" role="tablist" aria-label="Transaction type">
                <button role="tab" aria-selected={action === 'deposit'} className={action === 'deposit' ? 'selected' : ''} onClick={() => selectAction('deposit')}>
                  <ArrowIcon /> Deposit
                </button>
                <button role="tab" aria-selected={action === 'withdraw' ? 'selected' : ''} className={action === 'withdraw' ? 'selected' : ''} onClick={() => selectAction('withdraw')}>
                  <ArrowIcon direction="up" /> Withdraw
                </button>
              </div>

              <form onSubmit={submitTransaction}>
                <div className="amount-header">
                  <label htmlFor="amount">Amount</label>
                  {action === 'withdraw' && isConnected && isCorrectNetwork && (
                    <button type="button" className="max-button" onClick={() => setAmount(ethers.formatEther(balance))}>MAX <span>{formatEtherDisplay(balance)} ETH</span></button>
                  )}
                </div>
                <div className="amount-input-wrap">
                  <input
                    id="amount"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="any"
                    placeholder="0.00"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    disabled={!isConnected || !isCorrectNetwork || transaction?.type === 'pending'}
                    autoComplete="off"
                  />
                  <span className="input-currency"><span className="eth-glyph">Ξ</span> ETH</span>
                </div>
                <div className="transaction-route">
                  <span>{action === 'deposit' ? 'From your wallet' : 'From contract balance'}</span>
                  <span className="route-line" />
                  <ArrowIcon size={15} />
                  <span>{action === 'deposit' ? 'To Bank contract' : 'To your wallet'}</span>
                </div>
                <button
                  type="submit"
                  className="submit-button"
                  disabled={!contract || !isConnected || !isCorrectNetwork || transaction?.type === 'pending' || !amount}
                >
                  {transaction?.type === 'pending' ? <><span className="button-loader" /> Processing transaction</> : <>{action === 'deposit' ? 'Deposit funds' : 'Withdraw funds'} <span>↗</span></>}
                </button>
              </form>

              {!isConnected && <p className="panel-hint"><WalletIcon size={16} /> Connect your wallet to enable transactions.</p>}
              {isConnected && !isCorrectNetwork && <p className="panel-hint">Switch networks to enable transactions.</p>}
              {transaction && (
                <div className={`transaction-status ${transaction.type}`} role="status">
                  <span className="status-icon">{transaction.type === 'success' ? '✓' : transaction.type === 'error' ? '!' : <span className="button-loader" />}</span>
                  <div>
                    <p>{transaction.message}</p>
                    {transaction.hash && <a className="mono hash" href={`${EXPLORER_TX_URL}${transaction.hash}`} target="_blank" rel="noreferrer">TX {shortenAddress(transaction.hash)} ↗</a>}
                  </div>
                </div>
              )}
              <div className="panel-footnote"><span>Network fee</span><span>Calculated by your wallet</span></div>
            </section>
          </div>
        ) : (
          <section className="activity-section activity-page" id="activity">
            <div className="activity-page-heading">
              <div>
                <p className="eyebrow">ETHEREUM HOODI · CHAIN {TARGET_CHAIN_ID}</p>
                <h2>Transaction history</h2>
                <p>{isConnected ? `Deposits and withdrawals for ${shortenAddress(account)}.` : 'Connect your wallet to view its saved transaction history.'}</p>
              </div>
              <div className="activity-actions">
                {isConnected && <button className="clear-history-button" onClick={clearHistory} disabled={activity.length === 0}>Clear history</button>}
                {isConnected && <button className="disconnect-button activity-disconnect" onClick={disconnectWallet}>Disconnect wallet</button>}
              </div>
            </div>

            {!isConnected ? (
              <div className="history-empty">
                <div className="empty-icon"><WalletIcon /></div>
                <strong>No wallet connected</strong>
                <p>Connect your wallet to load activity saved for this account on Ethereum Hoodi.</p>
                <button className="wallet-button primary" onClick={connectWallet} disabled={isConnecting || !bindingIsValid}><WalletIcon size={17} /> {isConnecting ? 'Connecting…' : 'Connect Wallet'}</button>
              </div>
            ) : activity.length === 0 ? (
              <div className="history-empty">
                <div className="empty-icon"><ArrowIcon direction="up" /></div>
                <strong>No transactions yet</strong>
                <p>Your pending, completed, and failed deposits and withdrawals will appear here.</p>
                <button className="text-button" onClick={() => navigate('overview')}>Make your first transaction <span>→</span></button>
              </div>
            ) : (
              <div className="history-list">
                <div className="history-labels" aria-hidden="true"><span>Transaction</span><span>Amount</span><span>Status</span><span>Hash</span><span>Date</span></div>
                {activity.map((item) => {
                  const status = ['pending', 'success', 'failed'].includes(item.status) ? item.status : 'failed';
                  const timestamp = item.confirmedAt || item.failedAt || item.createdAt;
                  return (
                    <article className="history-item" key={item.id}>
                      <div className="history-type">
                        <span className={`activity-icon ${item.action}`}><ArrowIcon direction={item.action === 'deposit' ? 'down' : 'up'} /></span>
                        <div><strong>{item.action === 'deposit' ? 'Deposit' : 'Withdrawal'}</strong><span>Bank contract</span></div>
                      </div>
                      <span className="history-amount">{item.action === 'deposit' ? '+' : '−'}{item.amount} <small>ETH</small></span>
                      <span className={`history-status ${status}`}><i />{status === 'success' ? 'Success' : status === 'pending' ? 'Pending' : 'Failed'}</span>
                      <span className="history-hash">
                        {item.hash ? <a className="mono" href={`${EXPLORER_TX_URL}${item.hash}`} target="_blank" rel="noreferrer" title={item.hash}>{shortenAddress(item.hash)} ↗</a> : <span className="mono">Not submitted</span>}
                      </span>
                      <time className="history-time" dateTime={new Date(timestamp).toISOString()} title={new Date(timestamp).toLocaleString()}>
                        <span>{new Date(timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                        <span>{new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      </time>
                    </article>
                  );
                })}
              </div>
            )}
            {isConnected && activity.length > 0 && <p className="history-note">History is stored in this browser for this account and network. Transaction status is recorded by this app.</p>}
          </section>
        )}

        <footer className="app-footer">
          <span>Direct contract interaction. No intermediaries.</span>
          <span className="mono">CHAIN {TARGET_CHAIN_ID}</span>
        </footer>
      </main>

      <div className="toast-region" aria-live="polite" aria-label="Notifications">
        {toasts.map((toast) => (
          <div className={`toast ${toast.type}`} key={toast.id} role={toast.type === 'error' ? 'alert' : 'status'}>
            <span className="toast-icon"><ToastIcon type={toast.type} /></span>
            <div className="toast-content">
              <strong>{toast.title}</strong>
              <p>{toast.message}</p>
              {toast.hash && <a className="mono toast-link" href={`${EXPLORER_TX_URL}${toast.hash}`} target="_blank" rel="noreferrer">{shortenAddress(toast.hash)} · View on Hoodi explorer ↗</a>}
            </div>
            <button className="toast-close" onClick={() => dismissToast(toast.id)} aria-label="Dismiss notification"><CloseIcon /></button>
            <span className="toast-progress" aria-hidden="true" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default App;
