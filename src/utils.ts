import { Contract, providers, Signer, BigNumber, utils, Wallet } from 'ethers';
import { chunk, flatten, isEmpty, sum, zipObject } from 'lodash';
import synthetix from 'synthetix';
import PerpsV2MarketConsolidatedJson from './abi/PerpsV2MarketConsolidated.json';
import PythAbi from './abi/Pyth.json';
import { createLogger } from './logging';
import { DelayedOrder, Network, Position } from './typed';
import { Block } from '@ethersproject/abstract-provider';
import { MULTICALL_ABI } from './abi/Multicall3';
import { UNIT, getPaginatedFromAndTo } from './keepers/helpers';
import { wei } from '@synthetixio/wei';

enum PaginationEntityType {
  POSITION = 'POSITION',
  ORDER = 'ORDER',
}

export const MAX_ADDRESS_PAGE_SIZE = 1000;
export const MAX_ADDRESS_PAGE_CALLS = 100;
export const MAX_ENTITY_PAGE_CALLS = 500;

const logger = createLogger('Utils');

interface KeeperContracts {
  exchangeRates: Contract;
  marketManager: Contract;
  marketSettings: Contract;
  markets: Record<string, { contract: Contract; asset: string; state: Contract }>;
  pyth: {
    priceFeedIds: Record<string, string>;
    endpoint: string;
    contract: Contract;
  };
  multicall: Contract;
}

// @see: https://docs.pyth.network/consume-data/evm
const PYTH_CONTRACT_ADDRESSES: Record<Network, string> = {
  [Network.OPT_GOERLI]: '0xff1a0f4744e8582DF1aE09D5611b887B6a12925C',
  [Network.OPT]: '0xff1a0f4744e8582DF1aE09D5611b887B6a12925C',
};

export const networkToSynthetixNetworkName = (network: Network): string => {
  switch (network) {
    case Network.OPT:
      return 'mainnet-ovm';
    case Network.OPT_GOERLI:
      return 'goerli-ovm';
    default:
      throw new Error(`Unsupported Synthetix Network Name Mapping '${network}'`);
  }
};

export const getSynthetixContractByName = (
  name: string,
  network: Network,
  provider: providers.BaseProvider,
  source?: string
): Contract => {
  const snxNetwork = networkToSynthetixNetworkName(network);

  // Sometimes the `target` and `source` are _not_ the same. Most of the time this is not true. If
  // a `source` is provided then `source` is used as the name in `getSource` and `name` for target.
  // However, when `source` is not defined, `name` is used for both.
  const abi = synthetix.getSource({ network: snxNetwork, contract: source ?? name }).abi;
  const address = synthetix.getTarget({ network: snxNetwork, contract: name }).address;

  logger.info(`Found ${name} contract at '${address}'`);
  return new Contract(address, abi, provider);
};

export const getPerpsContracts = async (
  marketKeys: string[],
  network: Network,
  pythPriceServer: string,
  signer: Signer,
  provider: providers.BaseProvider
): Promise<KeeperContracts> => {
  const marketManager = getSynthetixContractByName('FuturesMarketManager', network, provider);
  const exchangeRates = getSynthetixContractByName('ExchangeRates', network, provider);
  const marketSettings = getSynthetixContractByName('PerpsV2MarketSettings', network, provider);
  const perpsV2ExchangeRates = getSynthetixContractByName('PerpsV2ExchangeRate', network, provider);

  // @see: https://www.multicall3.com/deployments
  const multicall = new Contract(
    '0xcA11bde05977b3631167028862bE2a173976CA11',
    MULTICALL_ABI,
    signer
  );

  logger.info('Fetching available perps markets...');
  const marketSummaries = await marketManager.allMarketSummaries();
  const markets: KeeperContracts['markets'] = marketSummaries.reduce(
    (
      acc: KeeperContracts['markets'],
      {
        proxied,
        market,
        marketKey,
        asset,
      }: { proxied: boolean; market: string; marketKey: string; asset: string }
    ) => {
      marketKey = utils.parseBytes32String(marketKey);
      if (!proxied) {
        logger.info(`Skipping market (not proxied): '${marketKey} @ '${market}`);
        return acc;
      }

      if (marketKeys.length > 0 && !marketKeys.includes(marketKey)) {
        logger.info(`Skipping market (not explicit): '${marketKey}' @ ${market}`);
        return acc;
      }

      const stateContractName = 'PerpsV2MarketState' + marketKey.replace(/^s/, '');
      const marketState = getSynthetixContractByName(
        stateContractName,
        network,
        provider,
        'PerpsV2MarketState'
      );
      if (!marketState) {
        logger.info(`Skipping market (missing state): '${marketKey} @ '${market}`);
        return acc;
      }

      logger.info(`Found market: '${marketKey}' @ '${market}'`);
      acc[marketKey] = {
        contract: new Contract(market, PerpsV2MarketConsolidatedJson.abi, signer),
        state: marketState,
        asset: utils.parseBytes32String(asset),
      };
      return acc;
    },
    {}
  );

  logger.info('Fetching Pyth price feeds for kept markets...');
  const marketValues = Object.values(markets);
  const marketAssets = marketValues.map(({ asset }) => asset);
  const marketPriceFeedIds = await Promise.all(
    marketAssets.map(
      (asset): Promise<string> =>
        perpsV2ExchangeRates.offchainPriceFeedId(utils.formatBytes32String(asset))
    )
  );
  const priceFeedIds = zipObject(marketAssets, marketPriceFeedIds);
  Object.keys(priceFeedIds).forEach(asset => {
    logger.info(`Pyth price feedId: ${asset} @ '${priceFeedIds[asset]}'`);
  });

  logger.info(`Keeping ${marketValues.length}/${marketSummaries.length} markets`);
  const pyth = {
    endpoint: pythPriceServer,
    priceFeedIds,
    contract: new Contract(PYTH_CONTRACT_ADDRESSES[network], PythAbi, provider),
  };
  logger.info(`Configuring off-chain with server '${pythPriceServer}'`);

  return { exchangeRates, marketManager, marketSettings, markets, pyth, multicall };
};

export const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/* --- Pagination --- */

const getAddressLengthByMarket = async (
  markets: KeeperContracts['markets'],
  multicall: Contract,
  block: providers.Block,
  type: PaginationEntityType
): Promise<Record<string, BigNumber>> => {
  const marketKeys = Object.keys(markets);

  let rpcFunctionName: string;
  if (type === PaginationEntityType.POSITION) {
    rpcFunctionName = 'getPositionAddressesLength';
  }
  if (type === PaginationEntityType.ORDER) {
    rpcFunctionName = 'getDelayedOrderAddressesLength';
  }

  const getLengthCalls = marketKeys.map(marketKey => {
    const { state } = markets[marketKey];
    return {
      target: state.address,
      callData: state.interface.encodeFunctionData(rpcFunctionName),
    };
  });
  const result = await multicall.callStatic.aggregate(getLengthCalls, {
    blockTag: block.number,
  });

  const lengthByMarket: Record<string, BigNumber> = {};
  result.returnData.forEach((data: string, i: number) => {
    const marketKey = marketKeys[i];
    const { state } = markets[marketKey];
    const length: BigNumber = state.interface.decodeFunctionResult(
      state.interface.getFunction(rpcFunctionName),
      data
    )[0];
    // Avoid processing markets that have no positions.
    if (length.gt(0)) {
      lengthByMarket[marketKey] = length;
    }
  });
  return lengthByMarket;
};

const getAddressesByLengths = async (
  lengthByMarket: Record<string, BigNumber>,
  markets: KeeperContracts['markets'],
  multicall: Contract,
  block: providers.Block,
  type: PaginationEntityType
) => {
  const marketKeys = Object.keys(lengthByMarket); // may not include _all_ markets.

  // For each lengths by market, create up to n pages.
  const pages = marketKeys.flatMap(marketKey => {
    return getPaginatedFromAndTo(
      0,
      lengthByMarket[marketKey].toNumber(),
      MAX_ADDRESS_PAGE_SIZE
    ).map(pagination => ({ pagination, marketKey }));
  });

  let rpcFunctionName: string;
  if (type === PaginationEntityType.POSITION) {
    rpcFunctionName = 'getPositionAddressesPage';
  }
  if (type === PaginationEntityType.ORDER) {
    rpcFunctionName = 'getDelayedOrderAddressesPage';
  }

  // Page the list of paginations - just in case there are _heaps_ of orders or
  // if MAX_POSITION_ADDRESS_PAGE_SIZE is really small or if we have a lot of markets.
  //
  // [{ { to, from, size }, marketKey }, ...]
  const addressesByMarket: Record<string, string[]> = {};
  for (const batch of chunk(pages, MAX_ADDRESS_PAGE_CALLS)) {
    const getPageCalls = batch.map(({ pagination, marketKey }) => {
      const { state } = markets[marketKey];
      const { from, size } = pagination;
      return {
        target: state.address,
        callData: state.interface.encodeFunctionData(rpcFunctionName, [from, size]),
      };
    });
    const result = await multicall.callStatic.aggregate(getPageCalls, {
      blockTag: block.number,
    });
    result.returnData.forEach((data: string, i: number) => {
      const { marketKey } = batch[i];
      const { state } = markets[marketKey];
      const addresses = state.interface.decodeFunctionResult(
        state.interface.getFunction(rpcFunctionName),
        data
      )[0];

      // Pair up the addresses with the corresponding marketKey.
      addressesByMarket[marketKey] = (addressesByMarket[marketKey] ?? []).concat(addresses);
    });
  }
  return addressesByMarket;
};

const getPositionsByAddresses = async (
  addressesByMarket: Record<string, string[]>,
  markets: KeeperContracts['markets'],
  multicall: Contract,
  block: providers.Block
) => {
  const marketKeys = Object.keys(addressesByMarket);

  // Flatten out all addresses, pairing with the marketKey then chunk them into batches.
  const flattenedAddressesWithMarketKey = marketKeys.flatMap(marketKey =>
    addressesByMarket[marketKey].map(address => ({ address, marketKey }))
  );

  const rpcFunctionName = 'positions';

  const ordersByMarket: Record<string, Position[]> = {};
  for (const batch of chunk(flattenedAddressesWithMarketKey, MAX_ENTITY_PAGE_CALLS)) {
    const delayedOrdersCalls = batch.map(({ address, marketKey }) => {
      const { state } = markets[marketKey];
      return {
        target: state.address,
        callData: state.interface.encodeFunctionData(rpcFunctionName, [address]),
      };
    });

    const result = await multicall.callStatic.aggregate(delayedOrdersCalls, {
      blockTag: block.number,
    });

    result.returnData.forEach((data: string, i: number) => {
      const { marketKey, address } = batch[i];
      const { state } = markets[marketKey];
      const response = state.interface.decodeFunctionResult(
        state.interface.getFunction(rpcFunctionName),
        data
      )[0];
      const position: Position = {
        account: address,
        id: response.id,
        size: wei(response.size)
          .div(UNIT)
          .toNumber(),
        leverage: wei(response.size)
          .abs()
          .mul(response.lastPrice)
          .div(response.margin)
          .div(UNIT)
          .toNumber(),
        liqPrice: -1, // will be updated by keeper routine
        liqPriceUpdatedTimestamp: block.timestamp,
      };

      ordersByMarket[marketKey] = (ordersByMarket[marketKey] ?? []).concat([position]);
    });
  }

  return ordersByMarket;
};

// Fetch all open positions across supported markets, pinned at `block`.
export const getOpenPositions = async (
  markets: KeeperContracts['markets'],
  multicall: Contract,
  block: Block,
  provider: providers.JsonRpcProvider
): Promise<Record<string, Position[]>> => {
  logger.info('Fetching on-chain positions pinned at block', {
    args: { blockNumber: block.number },
  });

  const lengthByMarket = await getAddressLengthByMarket(
    markets,
    multicall,
    block,
    PaginationEntityType.POSITION
  );

  if (isEmpty(lengthByMarket)) {
    return {};
  }

  // Unfortunately we cannot perform a multicall on position pagination due to `.call` and not `.delegate` on
  // the multicall contract (addressesPage has a `onlyAssociatedContracts`). Instead, we'll simply iterate over
  // possible values by lengths defined above.
  //
  // The expected output will match `getAddressesByLengths` (marketId -> address[]).

  const addressesByMarket: Record<string, string[]> = {};
  for (const marketKey in lengthByMarket) {
    const { state } = markets[marketKey];
    console.log(state.address);

    const associatedContractAddress = (await state.associatedContracts())[0];
    const total = lengthByMarket[marketKey].toNumber();

    const pages = getPaginatedFromAndTo(0, total, MAX_ADDRESS_PAGE_SIZE);
    logger.info('Fetching addresses', { args: { marketKey, total } });

    const getPositionAddressesCalls = pages.map(page => {
      const { from, size } = page;
      return state
        .connect(provider.getSigner(associatedContractAddress))
        .getPositionAddressesPage(from, size, {
          from: associatedContractAddress,
          blockTag: block.number,
        });
    });
    const addresses = flatten(await Promise.all(getPositionAddressesCalls));
    console.log(addresses);
    addressesByMarket[marketKey] = addresses;
  }

  const total = sum(Object.values(lengthByMarket).map(l => l.toNumber()));
  logger.info('Fetched all on-chain positions', { args: { total } });

  return await getPositionsByAddresses(addressesByMarket, markets, multicall, block);
};

const getOrdersByAddresses = async (
  addressesByMarket: Record<string, string[]>,
  markets: KeeperContracts['markets'],
  multicall: Contract,
  block: providers.Block
) => {
  const marketKeys = Object.keys(addressesByMarket);

  // Flatten out all addresses, pairing with the marketKey then chunk them into batches.
  const flattenedAddressesWithMarketKey = marketKeys.flatMap(marketKey =>
    addressesByMarket[marketKey].map(address => ({ address, marketKey }))
  );

  const rpcFunctionName = 'delayedOrders';

  const ordersByMarket: Record<string, DelayedOrder[]> = {};
  for (const batch of chunk(flattenedAddressesWithMarketKey, MAX_ENTITY_PAGE_CALLS)) {
    const delayedOrdersCalls = batch.map(({ address, marketKey }) => {
      const { state } = markets[marketKey];
      return {
        target: state.address,
        callData: state.interface.encodeFunctionData(rpcFunctionName, [address]),
      };
    });

    const result = await multicall.callStatic.aggregate(delayedOrdersCalls, {
      blockTag: block.number,
    });

    result.returnData.forEach((data: string, i: number) => {
      const { marketKey, address } = batch[i];
      const { state } = markets[marketKey];
      const rawDelayedOrder = state.interface.decodeFunctionResult(
        state.interface.getFunction(rpcFunctionName),
        data
      )[0];
      if (rawDelayedOrder.isOffchain) {
        const delayedOrder: DelayedOrder = {
          account: address,
          executableAtTime: rawDelayedOrder.executableAtTime,
          intentionTime: rawDelayedOrder.intentionTime,
          executionFailures: 0,
        };
        ordersByMarket[marketKey] = (ordersByMarket[marketKey] ?? []).concat([delayedOrder]);
      }
    });
  }

  return ordersByMarket;
};

export const getPendingOrders = async (
  markets: KeeperContracts['markets'],
  multicall: Contract,
  block: providers.Block
): Promise<Record<string, DelayedOrder[]>> => {
  logger.info('Fetching on-chain orders pinned at block', {
    args: { blockNumber: block.number },
  });

  // Get total number of pending orders for each available market.
  const lengthByMarket = await getAddressLengthByMarket(
    markets,
    multicall,
    block,
    PaginationEntityType.ORDER
  );

  // There are no pending orders to index.
  if (isEmpty(lengthByMarket)) {
    return {};
  }

  // For markets that have orders, fetch the actual addresses, paginated.
  const addressesByMarket = await getAddressesByLengths(
    lengthByMarket,
    markets,
    multicall,
    block,
    PaginationEntityType.ORDER
  );

  // Finally, for all addresses, fetch the actual delayed order.
  return getOrdersByAddresses(addressesByMarket, markets, multicall, block);
};
