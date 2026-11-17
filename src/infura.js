import { ethers } from 'ethers';

const apiKey = import.meta.env.VITE_INFURA_API_KEY?.trim() || '';
export const INFURA_CONFIGURED = Boolean(apiKey && apiKey !== 'YOUR_INFURA_API_KEY');
export const HOODI_RPC_URL = INFURA_CONFIGURED
  ? `https://hoodi.infura.io/v3/${apiKey}`
  : null;

export const infuraProvider = INFURA_CONFIGURED
  ? new ethers.JsonRpcProvider(HOODI_RPC_URL, { name: 'hoodi', chainId: 560048 }, { staticNetwork: true })
  : null;
