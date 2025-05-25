import { createRequestHandler } from '@remix-run/express';
import { type ServerBuild } from '@remix-run/node';
import compression from 'compression';
import express from 'express';
import morgan from 'morgan';
import { CronJob, CronTime } from 'cron';
import type ChainlinkDataStreamsConsumer from '@hackbg/chainlink-datastreams-consumer';
import { CronExpressionParser } from 'cron-parser';
import { logger } from 'server/services/logger.js';
import {
  executeContract as executeWriteContract,
  verifyReport,
} from 'server/services/client.js';
import { StreamReport } from 'server/types.js';
import { formatUSD, isPositive, printError } from 'server/utils.js';
import { readFile } from 'node:fs/promises';
import {
  addFeed,
  getAbi,
  getChainId,
  getFeedExists,
  getFeedName,
  getFeeds,
  getFunctionArgs,
  getFunctionName,
  getInterval,
  getLatestReport,
  getPriceDelta,
  getSavedReportBenchmarkPrice,
  getSkipVerify,
  removeFeed,
  seedConfig,
  setInterval,
  setLatestReport,
  setSavedReport,
} from './store.js';
import { schedule } from './services/limiter.js';
import { createDatastream } from './services/datastreams.js';
import { getReportPrice } from '~/lib/utils.js';
import { config } from './config/config.js';
import { isHex } from 'viem';

const viteDevServer =
  process.env.NODE_ENV === 'production'
    ? undefined
    : await import('vite').then((vite) =>
        vite.createServer({
          server: { middlewareMode: true },
        })
      );

const app = express();

app.use(express.json());
app.use(compression());

// http://expressjs.com/en/advanced/best-practice-security.html#at-a-minimum-disable-x-powered-by-header
app.disable('x-powered-by');

// handle asset requests
if (viteDevServer) {
  app.use(viteDevServer.middlewares);
} else {
  // Vite fingerprints its assets so we can cache forever.
  app.use(
    '/assets',
    express.static('build/client/assets', { immutable: true, maxAge: '1y' })
  );
}

// Everything else (like favicon.ico) is cached for an hour. You may want to be
// more aggressive with this caching.
app.use(express.static('build/client', { maxAge: '1h' }));

app.use(morgan('tiny'));

async function getBuild() {
  try {
    const build = viteDevServer
      ? await viteDevServer.ssrLoadModule('virtual:remix/server-build')
      : // @ts-expect-error - the file might not exist yet but it will
        // eslint-disable-next-line import/no-unresolved
        await import('../build/server/remix.js');

    return { build: build as unknown as ServerBuild, error: null };
  } catch (error) {
    // Catch error and return null to make express happy and avoid an unrecoverable crash
    console.error('Error creating build:', error);
    return { error: error, build: null as unknown as ServerBuild };
  }
}

const router = express.Router();

router.post('/interval', async (req, res) => {
  try {
    const interval: string = req.body.interval;
    if (!interval) throw new Error('New interval input is missing');

    const cronExpression = CronExpressionParser.parse(interval);
    const parsedInterval = cronExpression.stringify(true);

    setInterval(parsedInterval);
    if (jobs.length > 0)
      jobs.forEach(({ job }) => job.setTime(new CronTime(parsedInterval)));

    if (jobs.length < 1) {
      const feeds = await getFeeds();
      initJobs({ feeds, interval: parsedInterval });
    }

    logger.info(`📢 New interval has been set ${parsedInterval}`, {
      interval: parsedInterval,
    });
    res.send({ interval: parsedInterval });
  } catch (err) {
    logger.warn('⚠ New interval invalid input', { body: req.body, err });
    res.status(400);
    return res.send({ warning: 'Invalid input' });
  }
});

router.post('/feeds/add', async (req, res) => {
  const name: string = req.body.name;
  const feedId: string = req.body.feedId;

  if (!name || !feedId || !isHex(feedId)) {
    logger.warn('⚠ Add feed invalid input', { body: req.body });
    res.status(400);
    return res.send({ warning: 'Add feed invalid input' });
  }
  const isFeedExist = await getFeedExists(feedId);

  if (isFeedExist) {
    logger.info('⚠ Feed already exists', { feed: { name, feedId } });
    res.status(400);
    return res.send({ warning: 'Feed already exists' });
  }

  await addFeed({ feedId, name });
  const interval = await getInterval();
  if (!interval) {
    logger.warn('⚠ Interval is missing. Set interval and try again');
    res.status(400);
    return res.send({ warning: 'Interval missing' });
  }
  const consumer = createDatastream([feedId]);
  consumer.on('report', async (report: StreamReport) => {
    setLatestReport(report);
  });
  jobs.push({
    feedId,
    job: createCronJob(feedId, interval),
    consumer,
  });
  logger.info(`📢 New feed ${name} has been added`, { feed: { name, feedId } });
  res.send(await getFeeds());
});

router.post('/feeds/remove', async (req, res) => {
  const feedId: string = req.body.feedId;
  if (!feedId) {
    logger.warn('⚠ Remove feed invalid input', { body: req.body });
    res.status(400);
    return res.send({ warning: 'Remove feed invalid input' });
  }

  const feedExists = getFeedExists(feedId);

  if (!feedExists) {
    logger.warn('⚠️ Feed does not exists', { feedId });
    res.status(400);
    return res.send({ warning: 'Feed does not exists' });
  }

  const job = jobs.find((job) => job.feedId === feedId);

  if (!job) {
    logger.warn('⚠️ Job does not exists', { feedId });
    res.status(400);
    return res.send({ warning: 'Job does not exists' });
  }

  const name = await getFeedName(feedId);
  await job.consumer.unsubscribeFrom(feedId);
  job.job.stop();
  await removeFeed(feedId);
  jobs.splice(jobs.indexOf(job), 1);
  logger.info(`📢 Feed ${name} has been removed`, { feed: { feedId, name } });

  res.send(await getFeeds());
});

router.get('/logs', async (req, res) => {
  try {
    const log = await readFile('./logs/all/all.log', 'utf8');
    return res.send({ log });
  } catch (error) {
    logger.error(printError(error), error);
    console.error(error);
    return res.send({ log: null });
  }
});

router.post('/start', async (req, res) => {
  await Promise.all(
    jobs.map(async ({ consumer, feedId, job }) => {
      await consumer.subscribeTo([feedId]);
      job.start();
    })
  );
  const feeds = jobs.map(({ feedId }) => feedId);
  logger.info('🏁 All streams have been started', {
    feeds,
  });
  res.send({ feeds });
});

router.post('/stop', async (req, res) => {
  await Promise.all(
    jobs.map(async ({ consumer, job }) => {
      const feeds = [...consumer.feeds];
      await consumer.unsubscribeFrom(feeds);
      job.stop();
    })
  );
  const feeds = jobs.map(({ feedId }) => feedId);
  logger.info('🛑 All streams have been stopped', { feeds });
  res.send({ feedsStopped: feeds });
});

router.get('/latest/:feedId', async (req, res) => {
  const feedId = req.params.feedId;
  const latestReport = getLatestReport(feedId);
  res.send({ latestPrice: getReportPrice(latestReport).toString() });
});

router.get('/status/:feedId', async (req, res) => {
  const feedId = req.params.feedId;
  const job = jobs.find((j) => j.feedId === feedId);
  const status = job?.consumer.socketState;
  res.send({ status });
});

app.use('/api', router);

app.get('/ready', (req, res) => {
  res.status(200).send({ status: 'ok' });
});

// handle SSR requests
app.all(
  '*',
  createRequestHandler({
    build: async () => {
      const { error, build } = await getBuild();
      if (error) {
        throw error;
      }
      return build;
    },
  })
);

const appPort = process.env.PORT || 3000;
const healthPort = process.env.HEALTH_PORT || 8081;

const healthApp = express();

healthApp.get('/ready', (req, res) => {
  res.status(200).send({ status: 'ok' });
});

healthApp.listen(healthPort, () => {
  logger.info(
    `🩺 Health check endpoint running at http://localhost:${healthPort}/ready`
  );
});

const jobs: {
  job: CronJob<null, null>;
  feedId: string;
  consumer: ChainlinkDataStreamsConsumer;
}[] = [];

app.listen(appPort, async () => {
  logger.info(`🚀 running at http://localhost:${appPort}`);
  await seedConfig(config);
  const feeds = await getFeeds();
  const interval = await getInterval();
  if (!interval) {
    logger.warn('⚠ Interval is missing. Set interval and try again');
    return;
  }

  initJobs({ feeds, interval });

  logger.info('🏁 Streams have been started', { feeds });
});

// https://docs.chain.link/data-streams/crypto-streams?network=arbitrum&page=1#testnet-crypto-streams

async function dataUpdater({ report }: { report: StreamReport }) {
  try {
    const chainId = await getChainId();
    if (!chainId) {
      logger.warn(
        `🛑 ChainId is missing. Connect to a chain and try again | Aborting`
      );
      return;
    }
    const { feedId } = report;
    const functionName = await getFunctionName(feedId, chainId);
    if (!functionName) {
      logger.warn(`🛑 Function name is missing | Aborting`);
      return;
    }
    const abi = await getAbi(feedId, chainId);
    if (!abi) {
      logger.warn(`🛑 Contract ABI is missing | Aborting`);
      return;
    }

    const skipVerify = (await getSkipVerify(feedId, chainId)) === 'true';

    const reportPayload = skipVerify ? report : await verifyReport(report);
    if (!reportPayload) {
      if (!reportPayload) {
        logger.warn(`🛑 Verified report is missing | Aborting`);
        return;
      }
    }

    const transaction = await executeWriteContract({
      report: reportPayload,
      abi: JSON.parse(abi),
      functionName,
      functionArgs: await getFunctionArgs(feedId, chainId),
    });
    if (transaction?.status) {
      logger.info(`ℹ️ Transaction status: ${transaction?.status}`, {
        transaction,
      });
    }
    if (transaction?.status === 'success') {
      await setSavedReport(report);
      logger.info(
        `💾 Price stored | ${await getFeedName(feedId)}: ${formatUSD(
          getReportPrice(report)
        )}$`,
        { report }
      );
    }
  } catch (error) {
    logger.error(printError(error), error);
    console.error(error);
  }
}

function createCronJob(feedId: string, interval: string) {
  return new CronJob(
    interval,
    async function () {
      const report = getLatestReport(feedId);
      if (!report) {
        logger.warn(`🛑 No report logged | Aborting`);
        return;
      }
      await reconnectDataStreamIfStale(report);
      const latestBenchmarkPrice = getReportPrice(report);
      if (!latestBenchmarkPrice) return;
      const savedBenchmarkPrice = await getSavedReportBenchmarkPrice(feedId);
      const diff = latestBenchmarkPrice - BigInt(savedBenchmarkPrice ?? 0);
      const percentDiff =
        !savedBenchmarkPrice ||
        isNaN(Number(savedBenchmarkPrice)) ||
        Number(savedBenchmarkPrice) === 0
          ? 100
          : Number(
              ((latestBenchmarkPrice - BigInt(savedBenchmarkPrice)) *
                1000000n) /
                BigInt(savedBenchmarkPrice)
            ) / 10000;
      const priceDelta = await getPriceDelta();
      if (Math.abs(percentDiff) < Number(priceDelta ?? 0)) return;
      logger.info(
        `🚨 Price deviation detected | ${await getFeedName(
          report.feedId
        )}: ${formatUSD(latestBenchmarkPrice)}$ | ${
          isPositive(diff) ? '📈' : '📉'
        } ${isPositive(diff) ? '+' : ''}${percentDiff}% (${formatUSD(diff)}$)`,
        report
      );

      await schedule(() => dataUpdater({ report }));
    },
    null,
    true
  );
}

function initJobs({ feeds, interval }: { feeds: string[]; interval: string }) {
  try {
    jobs.push(
      ...feeds.map((feedId) => {
        const consumer = createDatastream([feedId]);
        
        // Add connection event logging
        consumer.on('connect', () => {
          logger.info(`🔌 Connected to Data Streams for feed ${feedId}`);
        });

        // Add disconnection event logging
        consumer.on('disconnect', () => {
          logger.warn(`🔌 Disconnected from Data Streams for feed ${feedId}`);
        });

        // Add error event logging
        consumer.on('error', (error: any) => {
          logger.error(`❌ Data Streams error for feed ${feedId}:`, error);
        });

        // Enhanced report logging
        consumer.on('report', async (report: StreamReport) => {
          logger.info(`📊 Received report for feed ${feedId}:`, {
            feedId,
            price: getReportPrice(report),
            timestamp: new Date(Number(report.validFromTimestamp) * 1000).toISOString(),
            expiresAt: new Date(Number(report.expiresAt) * 1000).toISOString(),
            nativeFee: report.nativeFee.toString(),
            linkFee: report.linkFee.toString()
          });
          setLatestReport(report);
        });

        return {
          feedId,
          job: createCronJob(feedId, interval),
          consumer,
        };
      })
    );
  } catch (error) {
    logger.error(printError(error), error);
    console.error(error);
  }
}

async function reconnectDataStreamIfStale(report: StreamReport) {
  try {
    const { feedId } = report;
    const reportTimestamp = Number(report.validFromTimestamp) * 1000;
    const nowTimestamp = Math.floor(Date.now());
    const staleInterval =
      Number(process.env.DATASTREAMS_WS_RECONNECT_STALE_INTERVAL) || 60000;
    if (nowTimestamp - reportTimestamp > staleInterval) {
      logger.info(
        `🔄 Last report is older than ${staleInterval} ms. | Reconnecting...`
      );
      const consumer = jobs.find((j) => j.feedId === feedId)?.consumer;
      if (!consumer) {
        logger.warn(`‼️ Invalid datastreams consumer | Aborting`);
        return;
      }
      const status = consumer.socketState;
      if (status !== 1) {
        logger.info(
          '⌛️ Reconnection was already initiated | Waiting for connection'
        );
        return;
      }
      await consumer.unsubscribeAll();
      await consumer.subscribeTo([feedId]);
      return;
    }
  } catch (error) {
    logger.error(printError(error), error);
    console.error(error);
  }
}
