# Bank DApp — Ethereum Hoodi + Infura

Original UI and contract address are preserved. The ABI function is spelled `checkBlance` in the deployed contract (not `checkBalance`).

## Setup (Windows PowerShell)

1. Install Node.js (18+ recommended).
2. Run `npm install`.
3. Run `Copy-Item .env.example .env`.
4. Edit `.env`: set `VITE_INFURA_API_KEY` to your own Infura API key. Create it at https://developer.metamask.io/ and enable Ethereum Hoodi.
5. Run `npm run dev` and open the displayed local URL.
6. Connect MetaMask, switch it to Ethereum Hoodi (chain ID `560048`), then test balance, deposit, and withdraw with test ETH.

## Architecture

- Read balance: Infura Hoodi RPC via `ethers.JsonRpcProvider` and `eth_call` with the connected account as `from`. The contract reads `msg.sender`, so this matters.
- Write transactions: MetaMask `BrowserProvider` + signer. Wallet approval is required.
- Contract address: `0xA51698cc42707C72abc93655D93d66430629313c` (unchanged).
- Local transaction history remains browser-local.

## Publish on GitHub Pages

Run `npm run build` and publish the contents of `dist/` using your preferred GitHub Pages deployment method. The relative Vite base supports project pages. Configure the Infura API key during build. `.env` is not committed, but **Vite embeds `VITE_` values into the public JavaScript bundle**. Restrict the key in your Infura dashboard to your site origins and only the APIs you need. Never place a private wallet key or Infura API secret in the frontend.

## Validation

`npm run build` checks the bundle. Actual RPC access and on-chain transactions require your API key, browser wallet, test ETH, and an accessible deployed contract.
