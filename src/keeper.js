const _ = require("lodash");
const ethers = require("ethers");
const { BigNumber: BN } = ethers;
const winston = require("winston");
const { format, transports } = require("winston");
const snx = require("synthetix");
const metrics = require("./metrics");

// async function runWithRetries(cb, retries = 3) {
//   try {
//     await cb();
//   } catch (ex) {
//     if (retries === 0) throw ex;
//     else await runWithRetries(cb, retries - 1);
//   }
// }

class Keeper {
  constructor({
    proxyFuturesMarket: proxyFuturesMarketAddress,
    exchangeRates: exchangeRatesAddress,
    signerPool,
    provider,
    network
  }) {
    // Get ABIs.
    const FuturesMarketABI = snx.getSource({
      network,
      contract: "FuturesMarket",
      useOvm: true
    }).abi;
    const ExchangeRatesABI = snx.getSource({
      network,
      contract: "ExchangeRatesWithoutInvPricing",
      useOvm: true
    }).abi;

    // The index.
    this.positions = {};

    // A mapping of already running keeper tasks.
    this.activeKeeperTasks = {};

    // A FIFO queue of blocks to be processed.
    this.blockQueue = [];

    const futuresMarket = new ethers.Contract(
      proxyFuturesMarketAddress,
      FuturesMarketABI,
      provider
    );
    this.futuresMarket = futuresMarket;

    const exchangeRates = new ethers.Contract(
      exchangeRatesAddress,
      ExchangeRatesABI,
      provider
    );
    this.exchangeRates = exchangeRates;

    this.blockTip = null;
    this.provider = provider;
    this.signerPool = signerPool;
  }

  async run({ fromBlock }) {
    const baseAsset = await this.futuresMarket.baseAsset();
    this.baseAsset = snx.fromBytes32(baseAsset);
    this.logger = winston.createLogger({
      level: "info",
      format: format.combine(
        format.colorize(),
        format.timestamp(),
        format.label({ label: `FuturesMarket [${this.baseAsset}]` }),
        format.printf(info => {
          return [
            info.timestamp,
            info.level,
            info.label,
            info.component,
            info.message
          ]
            .filter(x => !!x)
            .join(" ");
        })
      ),
      transports: [new transports.Console()]
    });

    this.logger.info(`market deployed at ${this.futuresMarket.address}`);

    const events = await this.futuresMarket.queryFilter(
      "*",
      fromBlock,
      "latest"
    );
    this.logger.log("info", `Rebuilding index from ${fromBlock} ... latest`, {
      component: "Indexer"
    });
    this.logger.log("info", `${events.length} events to process`, {
      component: "Indexer"
    });
    this.updateIndex(events);

    this.logger.log("info", `Index build complete!`, { component: "Indexer" });
    this.logger.log("info", `Starting keeper loop`);
    await this.runKeepers();

    this.logger.log("info", `Listening for events`);
    this.provider.on("block", async blockNumber => {
      if (!this.blockTip) {
        // Don't process the first block we see.
        this.blockTip = blockNumber;
        return;
      }

      this.logger.log("debug", `New block: ${blockNumber}`);
      this.blockQueue.push(blockNumber);
    });

    // The L2 node is constantly mining blocks, one block per transaction. When a new block is received, we queue it
    // for processing in a FIFO queue. `processNewBlock` will scan its events, rebuild the index, and then run any
    // keeper tasks that need running that aren't already active.
    while (1) {
      if (!this.blockQueue.length) {
        await new Promise((resolve, reject) => setTimeout(resolve, 0.001));
        continue;
      }

      const blockNumber = this.blockQueue.shift();
      await this.processNewBlock(blockNumber);
    }
  }

  async processNewBlock(blockNumber) {
    this.blockTip = blockNumber;
    const events = await this.futuresMarket.queryFilter(
      "*",
      blockNumber,
      blockNumber
    );
    const exchangeRateEvents = await this.exchangeRates.queryFilter(
      "*",
      blockNumber,
      blockNumber
    );

    this.logger.log("debug", `\nProcessing block: ${blockNumber}`, {
      component: "Indexer"
    });
    exchangeRateEvents
      .filter(
        ({ event, args }) => event === "RatesUpdated" || event === "RateDeleted"
      )
      .forEach(({ event }) => {
        this.logger.log("debug", `ExchangeRates ${event}`);
      });

    this.logger.log("debug", `${events.length} events to process`, {
      component: "Indexer"
    });
    await this.updateIndex(events);
    await this.runKeepers();
  }

  async updateIndex(events) {
    events.forEach(({ event, args }) => {
      if (event === "PositionModified") {
        const { id, account, size } = args;

        this.logger.log(
          "info",
          `PositionModified id=${id} account=${account}`,
          { component: "Indexer" }
        );

        if (size.eq(BN.from(0))) {
          // Position has been closed.
          delete this.positions[account];
          return;
        }

        this.positions[account] = {
          id,
          event,
          account,
          size
        };
      } else if (event === "PositionLiquidated") {
        const { account, liquidator } = args;
        this.logger.log(
          "info",
          `PositionLiquidated account=${account} liquidator=${liquidator}`,
          { component: "Indexer" }
        );

        delete this.positions[account];
      } else if (event === "FundingRecomputed") {
        // // Recompute liquidation price of all positions.
        // await Object.values(this.positions).map(position => {
        //   const includeFunding = true
        //   const { price: liqPrice, invalid } = await this.futuresMarket.liquidationPrice(position.account, includeFunding)
        //   if (invalid) return
        //   this.positions[position.account].liqPrice = liqPrice
        // })
      } else if (!event || event.match(/OrderSubmitted/)) {
      } else {
        this.logger.log("info", `No handler for event ${event}`, {
          component: "Indexer"
        });
      }
    });
  }

  async runKeepers() {
    const numPositions = Object.keys(this.positions).length;
    metrics.futuresOpenPositions.set({ market: this.baseAsset }, numPositions);
    this.logger.log("info", `${numPositions} positions to keep`, {
      component: "Keeper"
    });

    // Open positions.

    // Sort positions by size and liquidationPrice.

    // Get current liquidation price for each position (including funding).

    // const BATCH_SIZE = 50
    // const WAIT = 2000
    // const positions = Object.values(this.positions)

    // for (const batch of _.chunk(positions, BATCH_SIZE)) {
    //   await Promise.all(batch.map(async (position) => {
    //     const { id, account } = position
    //     await this.runKeeperTask(id, 'liquidation', () =>
    //       this.liquidateOrder(id, account)
    //     );
    //   }));
    //   await new Promise((res, rej) => setTimeout(res, WAIT))
    // }

    // Serial tx submission for now until Optimism can stop rate-limiting us.
    for (const { id, account } of Object.values(this.positions)) {
      await this.runKeeperTask(id, "liquidation", () =>
        this.liquidateOrder(id, account)
      );
    }
  }

  async runKeeperTask(id, taskLabel, cb) {
    if (this.activeKeeperTasks[id]) {
      // Skip task as its already running.
      return;
    }
    this.activeKeeperTasks[id] = true;

    this.logger.log("info", `running`, {
      component: `Keeper [${taskLabel}] id=${id}`
    });
    try {
      await cb();
    } catch (err) {
      this.logger.log("error", `error \n${err.toString()}`, {
        component: `Keeper [${taskLabel}] id=${id}`
      });
      metrics.keeperErrors.observe({ market: this.baseAsset }, 1);
    }
    this.logger.log("info", `done`, {
      component: `Keeper [${taskLabel}] id=${id}`
    });

    delete this.activeKeeperTasks[id];
  }

  async liquidateOrder(id, account) {
    const taskLabel = "liquidation";
    const canLiquidateOrder = await this.futuresMarket.canLiquidate(account);
    if (!canLiquidateOrder) {
      this.logger.log("info", `Cannot liquidate order`, {
        component: `Keeper [${taskLabel}] id=${id}`
      });
      return;
    }

    this.logger.log("info", `begin liquidatePosition`, {
      component: `Keeper [${taskLabel}] id=${id}`
    });
    let tx, receipt;

    try {
      await this.signerPool.withSigner(async signer => {
        tx = await this.futuresMarket
          .connect(signer)
          .liquidatePosition(account);
        this.logger.log(
          "debug",
          `submit liquidatePosition [nonce=${tx.nonce}]`,
          { component: `Keeper [${taskLabel}] id=${id}` }
        );

        receipt = await tx.wait(1);
      });
    } catch (err) {
      metrics.futuresLiquidations.observe(
        { market: this.baseAsset, success: false },
        1
      );

      if (err.code) {
        // Ethers error.
        if (err.code === "NONCE_EXPIRED") {
          // We can't recover from this one yet, restart.
          this.logger.log("error", err.toString());
          process.exit(-1);
        }
      }

      throw err;
    }

    metrics.futuresLiquidations.observe(
      { market: this.baseAsset, success: true },
      1
    );

    this.logger.log(
      "info",
      `done liquidatePosition`,
      `block=${receipt.blockNumber}`,
      `success=${!!receipt.status}`,
      `tx=${receipt.transactionHash}`,
      `gasUsed=${receipt.gasUsed}`,
      { component: `Keeper [${taskLabel}] id=${id}` }
    );
  }
}

module.exports = Keeper;
