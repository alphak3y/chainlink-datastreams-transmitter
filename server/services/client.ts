import {
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  encodeAbiParameters,
  http,
  erc20Abi,
  formatEther,
  zeroAddress,
  isAddress,
  isAddressEqual,
  Abi,
  Hex,
  formatUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  estimateContractGas,
  simulateContract,
  waitForTransactionReceipt,
  writeContract,
  readContract,
  getBalance,
} from 'viem/actions';
import { ReportV3, ReportV4, StreamReport } from '../types';
import { feeManagerAbi, verifierProxyAbi } from '../config/abi';
import { logger } from './logger';
import {
  getChainId,
  getContractAddress,
  getGasCap,
  setChainId,
} from '../store';
import { getVerifier } from '../config/verifiers';
import { defaultChains, getCustomChains } from '../config/chains';
import { printError } from '../utils';

const getAccount = () => {
  try {
    return privateKeyToAccount(process.env.PRIVATE_KEY as Hex);
  } catch (error) {
    logger.error(printError(error), error);
    console.error(error);
    return;
  }
};
export const accountAddress = getAccount()?.address ?? zeroAddress;

export async function executeContract({
  report,
  abi,
  functionName,
  functionArgs,
}: {
  report: ReportV3 | ReportV4 | StreamReport;
  abi: Abi;
  functionName: string;
  functionArgs: string[];
}) {
  try {
    const chainId = await getChainId();
    if (!chainId) {
      logger.warn('⚠️ Chain is missing. Connect to a chain and try again');
      return;
    }
    const account = getAccount();
    if (!account) {
      logger.error('‼️ Account is missing');
      return;
    }

    if (!abi || abi.length === 0) {
      logger.warn('⚠️ No abi provided');
      return;
    }
    if (!functionName || functionName.length === 0) {
      logger.warn('⚠️ No functionName provided');
      return;
    }
    if (!functionArgs || functionArgs.length === 0) {
      logger.warn('⚠️ No args provided');
      return;
    }

    logger.info('📝 Prepared verification transaction', report);

    const args = functionArgs.map((arg) => report[arg as keyof typeof report]);
    console.log('args check:', args);
    const address = await getContractAddress(report.feedId, chainId);
    if (!address || !isAddress(address)) {
      logger.warn('⚠️ Contract address is missing');
      return;
    }
    console.log('address check:', address);
    const clients = await getClients();
    if (!clients || !clients.publicClient || !clients.walletClient) {
      logger.warn('⚠️ Invalid clients', { clients });
      return;
    }
    const { publicClient, walletClient } = clients;
    console.log('publicClient check');
    console.log('walletClient check');
    console.log('estimateContractGas args check');
    console.log('account check:', account);
    console.log('address check:', address);
    console.log('abi check:', abi);
    console.log('functionName check:', functionName);
    console.log('args check:', args);
    const gas = await estimateContractGas(publicClient, {
      account,
      address,
      abi,
      functionName,
      args,
    });
    logger.info(
      `⛽️ Estimated gas: ${formatEther(gas)} ${
        publicClient.chain?.nativeCurrency.symbol
      }`,
      { gas }
    );
    const gasCap = await getGasCap();
    if (gasCap && gas > BigInt(gasCap)) {
      logger.warn(
        `🛑 Gas is above the limit of ${formatEther(
          BigInt(gasCap)
        )} | Aborting`,
        { gas, gasCap }
      );
      return;
    }
    const { request } = await simulateContract(publicClient, {
      account,
      address,
      abi,
      functionName,
      args,
    });
    logger.info('ℹ️ Transaction simulated', request);

    const hash = await writeContract(walletClient, request);
    logger.info(`⌛️ Sending transaction ${hash} `, hash);
    const txReceipt = await waitForTransactionReceipt(publicClient, { hash });
    return txReceipt;
  } catch (error) {
    logger.error(printError(error), error);
    console.error(error);
  }
}

async function getContractAddresses() {
  try {
    const clients = await getClients();
    if (!clients || !clients.publicClient) {
      logger.warn('⚠️ Invalid clients', { clients });
      return {
        verifierProxyAddress: zeroAddress,
        feeManagerAddress: zeroAddress,
        rewardManagerAddress: zeroAddress,
        feeTokenAddress: zeroAddress,
      };
    }
    const { publicClient } = clients;
    const chainId = await getChainId();
    if (!chainId) {
      logger.warn('⚠️ No chainId provided');
      return;
    }
    const verifierProxyAddress = await getVerifier(chainId);
    if (!verifierProxyAddress) {
      logger.warn('⚠️ No verifier address provided');
      return;
    }

    const feeManagerAddress = await readContract(publicClient, {
      address: verifierProxyAddress,
      abi: verifierProxyAbi,
      functionName: 's_feeManager',
    });

    const [rewardManagerAddress, feeTokenAddress] = feeManagerAddress === zeroAddress 
      ? [zeroAddress, zeroAddress]
      : await Promise.all([
          readContract(publicClient, {
            address: feeManagerAddress,
            abi: feeManagerAbi,
            functionName: 'i_rewardManager',
          }),
          readContract(publicClient, {
            address: feeManagerAddress,
            abi: feeManagerAbi,
            functionName: 'i_linkAddress',
          }),
        ]);

    return {
      verifierProxyAddress,
      feeManagerAddress,
      rewardManagerAddress,
      feeTokenAddress,
    };
  } catch (error) {
    logger.error(printError(error), error);
    console.error(error);
    return {
      verifierProxyAddress: zeroAddress,
      feeManagerAddress: zeroAddress,
      rewardManagerAddress: zeroAddress,
      feeTokenAddress: zeroAddress,
    };
  }
}

export async function verifyReport(report: StreamReport) {
  try {
    const account = getAccount();
    if (!account) {
      logger.error('‼️ Account is missing');
      return;
    }
    const clients = await getClients();
    if (!clients || !clients.publicClient || !clients.walletClient) {
      logger.warn('⚠️ Invalid clients', { clients });
      return;
    }
    const { publicClient, walletClient } = clients;

    const [, reportData] = decodeAbiParameters(
      [
        { type: 'bytes32[3]', name: '' },
        { type: 'bytes', name: 'reportData' },
      ],
      report.rawReport
    );

    const reportVersion = parseInt(reportData.slice(0, 6), 16);
    if (reportVersion !== 3 && reportVersion !== 4) {
      logger.warn('⚠️ Invalid report version', { report });
      return;
    }

    const contractAddresses = await getContractAddresses();

    if (
      !contractAddresses ||
      Object.values(contractAddresses)
        .map((address) => isAddressValid(address))
        .includes(false)
    ) {
      logger.warn('⚠️ Invalid contract addresses', { contractAddresses });
      return;
    }

    const {
      feeManagerAddress,
      rewardManagerAddress,
      feeTokenAddress,
      verifierProxyAddress,
    } = contractAddresses;

    const feeTokenAddressEncoded = encodeAbiParameters(
      [{ type: 'address', name: 'parameterPayload' }],
      [feeTokenAddress]
    );

    const gasCap = await getGasCap();

    if (feeManagerAddress !== zeroAddress) {
      const [fee] = await readContract(publicClient, {
        address: feeManagerAddress,
        abi: feeManagerAbi,
        functionName: 'getFeeAndReward',
        args: [account.address, reportData, feeTokenAddress],
      });
      logger.info(`⛽️ Estimated fee: ${formatEther(fee.amount)} LINK`, { fee });

      const approveLinkGas = await estimateContractGas(publicClient, {
        account,
        address: feeTokenAddress,
        abi: erc20Abi,
        functionName: 'approve',
        args: [rewardManagerAddress, fee.amount],
      });

      logger.info(
        `⛽️ Estimated gas for LINK approval: ${formatEther(approveLinkGas)} ${
          publicClient.chain?.nativeCurrency.symbol
        }`,
        { approveLinkGas }
      );

      if (gasCap && approveLinkGas > BigInt(gasCap)) {
        logger.info(
          `🛑 LINK approval gas is above the limit of ${formatEther(
            BigInt(gasCap)
          )} | Aborting`,
          { approveLinkGas, gasCap }
        );
        return;
      }

      const { request: approveLinkRequest } = await simulateContract(
        publicClient,
        {
          account,
          address: feeTokenAddress,
          abi: erc20Abi,
          functionName: 'approve',
          args: [rewardManagerAddress, fee.amount],
        }
      );
      const approveLinkHash = await writeContract(
        walletClient,
        approveLinkRequest
      );
      const approveLinkReceipt = await waitForTransactionReceipt(publicClient, {
        hash: approveLinkHash,
      });

      if (approveLinkReceipt.status !== 'success') {
        logger.warn(
          `🛑 LINK approval transaction was not successful | Aborting`,
          { transactionReceipt: approveLinkReceipt }
        );
        return;
      }
    }

    const verifyReportGas = await estimateContractGas(publicClient, {
      account,
      address: verifierProxyAddress,
      abi: verifierProxyAbi,
      functionName: 'verify',
      args: [report.rawReport, feeTokenAddressEncoded],
    });
    logger.info(
      `⛽️ Estimated gas for verification: ${formatEther(verifyReportGas)} ${
        publicClient.chain?.nativeCurrency.symbol
      }`,
      { verifyReportGas }
    );
    if (gasCap && verifyReportGas > BigInt(gasCap)) {
      logger.warn(
        `🛑 Verification gas is above the limit of ${formatEther(
          BigInt(gasCap)
        )} | Aborting`,
        { verifyReportGas, gasCap }
      );
      return;
    }
    const { request: verifyReportRequest, result: verifiedReportData } =
      await simulateContract(publicClient, {
        account,
        address: verifierProxyAddress,
        abi: verifierProxyAbi,
        functionName: 'verify',
        args: [report.rawReport, feeTokenAddressEncoded],
      });
    const verifyReportHash = await writeContract(
      walletClient,
      verifyReportRequest
    );
    const verifyReportReceipt = await waitForTransactionReceipt(publicClient, {
      hash: verifyReportHash,
    });

    if (verifyReportReceipt.status !== 'success') {
      logger.warn(`🛑 Verification transaction was not successful | Aborting`, {
        transactionReceipt: verifyReportReceipt,
      });
      return;
    }

    if (reportVersion === 3) {
      const [
        feedId,
        validFromTimestamp,
        observationsTimestamp,
        nativeFee,
        linkFee,
        expiresAt,
        price,
        bid,
        ask,
      ] = decodeAbiParameters(
        [
          { type: 'bytes32', name: 'feedId' },
          { type: 'uint32', name: 'validFromTimestamp' },
          { type: 'uint32', name: 'observationsTimestamp' },
          { type: 'uint192', name: 'nativeFee' },
          { type: 'uint192', name: 'linkFee' },
          { type: 'uint32', name: 'expiresAt' },
          { type: 'int192', name: 'price' },
          { type: 'int192', name: 'bid' },
          { type: 'int192', name: 'ask' },
        ],
        verifiedReportData
      );
      const verifiedReport: ReportV3 = {
        feedId,
        validFromTimestamp,
        observationsTimestamp,
        nativeFee,
        linkFee,
        expiresAt,
        price,
        bid,
        ask,
        rawReport: report.rawReport,
      };
      logger.info('✅ Report verified', { verifiedReport });
      return verifiedReport;
    }
    if (reportVersion === 4) {
      const [
        feedId,
        validFromTimestamp,
        observationsTimestamp,
        nativeFee,
        linkFee,
        expiresAt,
        price,
        marketStatus,
      ] = decodeAbiParameters(
        [
          { type: 'bytes32', name: 'feedId' },
          { type: 'uint32', name: 'validFromTimestamp' },
          { type: 'uint32', name: 'observationsTimestamp' },
          { type: 'uint192', name: 'nativeFee' },
          { type: 'uint192', name: 'linkFee' },
          { type: 'uint32', name: 'expiresAt' },
          { type: 'int192', name: 'price' },
          { type: 'uint32', name: 'marketStatus' },
        ],
        verifiedReportData
      );
      const verifiedReport: ReportV4 = {
        feedId,
        validFromTimestamp,
        observationsTimestamp,
        nativeFee,
        linkFee,
        expiresAt,
        price,
        marketStatus,
        rawReport: report.rawReport,
      };
      logger.info('✅ Report verified', { verifiedReport });
      return verifiedReport;
    }
  } catch (error) {
    logger.error(printError(error), error);
    console.error(error);
  }
}

const isAddressValidAndNonZero = (address: string) =>
  !isAddress(address) || isAddressEqual(address, zeroAddress) ? false : true;

const isAddressValid = (address: string) =>
  !isAddress(address) ? false : true;

export async function getClients() {
  const chainId = await getChainId();
  if (!chainId) {
    logger.warn('⚠️ No chainId provided');
    return;
  }
  const storedChains = await getCustomChains();
  const storedChain = storedChains?.find(
    (chain: { id: number; }) => chain.id === Number(chainId)
  );

  if (storedChain) {
    const publicClient = createPublicClient({
      chain: storedChain,
      transport: http(),
    });

    const walletClient = createWalletClient({
      chain: storedChain,
      transport: http(),
    });
    return { publicClient, walletClient };
  }

  const defaultChain = defaultChains.find(
    (chain) => chain.id === Number(chainId)
  );
  if (!defaultChain) {
    logger.warn('⚠️ Invalid chain', { chainId });
    setChainId('');
    return;
  }

  const publicClient = createPublicClient({
    chain: defaultChain,
    transport: http(),
  });

  const walletClient = createWalletClient({
    chain: defaultChain,
    transport: http(),
  });
  return { publicClient, walletClient };
}

export async function getTokenBalance() {
  try {
    const clients = await getClients();
    if (!clients || !clients.publicClient) {
      logger.warn('⚠️ Invalid clients', { clients });
      return;
    }
    const { publicClient } = clients;
    const balance = await getBalance(publicClient, { address: accountAddress });
    return {
      value: formatEther(balance),
      symbol: publicClient.chain?.nativeCurrency.symbol,
    };
  } catch (error) {
    logger.error(printError(error), error);
    console.error(error);
    return {
      value: formatEther(0n),
      symbol: '',
    };
  }
}

export async function getLinkBalance() {
  try {
    const clients = await getClients();
    if (!clients || !clients.publicClient) {
      logger.warn('⚠️ Invalid clients', { clients });
      return;
    }
    const { publicClient } = clients;
    const contractAddresses = await getContractAddresses();

    if (
      !contractAddresses ||
      !isAddressValid(contractAddresses.feeTokenAddress)
    ) {
      logger.warn('⚠️ Invalid fee token addresses', { contractAddresses });
      return;
    }
    const { feeTokenAddress } = contractAddresses;
    const [balance, decimals, symbol] = await Promise.all([
      publicClient.readContract({
        address: feeTokenAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [accountAddress],
      }),
      publicClient.readContract({
        address: feeTokenAddress,
        abi: erc20Abi,
        functionName: 'decimals',
      }),
      publicClient.readContract({
        address: feeTokenAddress,
        abi: erc20Abi,
        functionName: 'symbol',
      }),
    ]);
    return {
      value: formatUnits(balance, decimals),
      symbol,
    };
  } catch (error) {
    logger.error(printError(error), error);
    console.error(error);
    return {
      value: formatEther(0n),
      symbol: '',
    };
  }
}

export async function getCurrentChain() {
  const clients = await getClients();
  if (!clients || !clients.publicClient) {
    logger.warn('⚠️ Invalid clients', { clients });
    return;
  }
  const { publicClient } = clients;
  return { chainId: publicClient.chain?.id, name: publicClient.chain?.name };
}
