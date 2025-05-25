import { logger } from '../services/logger';
import { getVerifierAddress, getVerifierAddresses } from '../store';
import { Address, isAddress } from 'viem';
import {
  arbitrum,
  arbitrumSepolia,
  avalanche,
  avalancheFuji,
  base,
  baseSepolia,
  opBNB,
  opBNBTestnet,
  optimism,
  optimismSepolia,
  scroll,
  scrollSepolia,
  shibarium,
  shibariumTestnet,
  soneiumMinato,
  sonic,
  sonicTestnet,
  worldchain,
  worldchainSepolia,
} from 'viem/chains';

export const defaultVerifiers: Record<number, Address> = {
  [arbitrum.id]: '0x478Aa2aC9F6D65F84e09D9185d126c3a17c2a93C',
  [arbitrumSepolia.id]: '0x2ff010DEbC1297f19579B4246cad07bd24F2488A',
  [avalanche.id]: '0x79BAa65505C6682F16F9b2C7F8afEBb1821BE3f6',
  [avalancheFuji.id]: '0x2bf612C65f5a4d388E687948bb2CF842FFb8aBB3',
  [base.id]: '0xDE1A28D87Afd0f546505B28AB50410A5c3a7387a',
  [baseSepolia.id]: '0x8Ac491b7c118a0cdcF048e0f707247fD8C9575f9',
  [opBNB.id]: '0x7D543D1a715ED544f7e3Ae9e3b1777BCdA56bF8e',
  [opBNBTestnet.id]: '0x001225Aca0efe49Dbb48233aB83a9b4d177b581A',
  [optimism.id]: '0xEBA4789A88C89C18f4657ffBF47B13A3abC7EB8D',
  [optimismSepolia.id]: '0x5f64394a2Ab3AcE9eCC071568Fc552489a8de7AF',
  [scroll.id]: '0x37e550C9b35DB56F9c943126F1c2642fcbDF7B51',
  [scrollSepolia.id]: '0xE17A7C6A7c2eF0Cb859578aa1605f8Bc2434A365',
  [shibarium.id]: '0xBE9f07f73de2412A9d0Ed64C42De7d9A10C9F28C',
  [shibariumTestnet.id]: '0xc44eb6c00A0F89D044279cD91Bdfd5f62f752Da3',
  [soneiumMinato.id]: '0x26603bAC5CE09DAE5604700B384658AcA13AD6ae',
  [sonic.id]: '0xfBFff08fE4169853F7B1b5Ac67eC10dc8806801d',
  [sonicTestnet.id]: '0xfBFff08fE4169853F7B1b5Ac67eC10dc8806801d',
  [worldchain.id]: '0x65eaE24251C5707D5aCBF7461A49fe87CB1bE4c7',
  [worldchainSepolia.id]: '0x2482A390bE58b3cBB6Df72dB2e950Db20256e55E',
};

export const getCustomVerifiers = async () => {
  const verifiersList = await getVerifierAddresses();
  return await Promise.all(
    verifiersList.map(async (chainId) => ({
      chainId,
      address: await getVerifierAddress(chainId),
    }))
  );
};

export const getAllVerifiers = async (): Promise<
  {
    chainId: string;
    address: string | null;
    default?: boolean;
  }[]
> => [
  ...Object.entries(defaultVerifiers).map(([chainId, address]) => ({
    chainId,
    address,
    default: true,
  })),
  ...(await getCustomVerifiers()),
];

export async function getVerifier(chainId: string) {
  console.log('chainId check:', chainId);
  const customVerifier = await getVerifierAddress(chainId);
  console.log('customVerifier check:', customVerifier);
  if (customVerifier && isAddress(customVerifier)) return customVerifier;
  const verifier = defaultVerifiers[Number(chainId)];
  console.log('verifier check:', verifier);
  if (!verifier) {
    logger.warn(`Verifier not found for chainId: ${chainId}`);
    return;
  }
  return verifier;
}
