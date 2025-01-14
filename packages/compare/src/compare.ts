/**
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */
import * as quantile from '@stdlib/stdlib/lib/node_modules/@stdlib/stats/base/dists/t/quantile';
import * as meanpw from '@stdlib/stdlib/lib/node_modules/@stdlib/stats/base/meanpw';
import * as variancepn from '@stdlib/stdlib/lib/node_modules/@stdlib/stats/base/variancepn';
import * as neatCSV from 'neat-csv';
import * as fs from 'fs';

const OUTPUT_FILE = process.env['BENCHMARK_OUTPUT'] || 'diff.csv';
const OLD_FILE = process.env['BENCHMARK_INPUT_OLD'] || 'old.csv';
const NEW_FILE = process.env['BENCHMARK_INPUT_NEW'] || 'new.csv';

const stream = fs.createWriteStream(OUTPUT_FILE);

function writeLine(line: string): Promise<void> {
  return new Promise(function(resolve, reject) {
    stream.write(line + '\n', error => (error ? reject(error) : resolve()));
  });
}
tests();

void main();

const MODE_LABEL = {
  open: 'opening a notebook',
  switch: 'switching to a notebook'
};
async function main() {
  console.log(`Writing output to ${OUTPUT_FILE}`);
  await writeLine('mode,browser,n,type,mean,confidenceInterval');

  for await (const {
    mode,
    browser,
    n,
    mean,
    type,
    confidenceInterval
  } of compare(OLD_FILE, NEW_FILE, 0.95)) {
    console.log(
      `In ${browser} ${
        MODE_LABEL[mode as keyof typeof MODE_LABEL]
      } with ${type} where n=${n} is ${formatChange({
        mean,
        confidenceInterval
      })} with 95% confidence.`
    );
    await writeLine(
      [mode, browser, n, type, mean, confidenceInterval].join(',')
    );
  }
}

type OutputRow = {
  mode: string;
  browser: string;
  type: string;
  n: number;
  mean: number;
  confidenceInterval: number;
};

async function* compare(
  oldCSVPath: string,
  newCSVPath: string,
  confidenceInterval: number = 0.95
): AsyncIterable<OutputRow> {
  const collected: {
    // turn key into string so we can lookup easily with it
    [key: string]: {
      mode: string;
      browser: string;
      type: string;
      n: number;
      times: { [VERSION in 'old' | 'new_']: number[] };
    };
  } = {};
  for (const { path, version } of [
    { path: oldCSVPath, version: 'old' as 'old' },
    { path: newCSVPath, version: 'new_' as 'new_' }
  ]) {
    console.log('Parsing data', { path, version });
    const text = await fs.promises.readFile(path);
    for (const { mode, browser, n, type, time } of await neatCSV(text)) {
      const key = `${mode}-${browser}-${n}-${type}`;
      // get key if we have it, otherwise create new
      const data =
        collected[key] ||
        (collected[key] = {
          mode,
          browser,
          n: parseInt(n),
          type,
          times: { old: [], new_: [] }
        });
      data.times[version].push(parseFloat(time));
    }
  }
  for (const {
    mode,
    browser,
    type,
    n,
    times: { old, new_ }
  } of Object.values(collected)) {
    if (old.length != new_.length) {
      console.warn('Skipping because different lengths between runs', {
        mode,
        browser,
        type,
        n
      });
      continue;
    }
    if (old.length <= 2) {
      console.warn('Skipping because not enough runs', {
        mode,
        browser,
        type,
        n
      });
      continue;
    }
    yield {
      mode,
      browser,
      type,
      n,
      ...performanceChangeFromData(old, new_, confidenceInterval)
    };
  }
}

/**
 * Quantifies the performance changes between two measures systems. Assumes we gathered
 * n independent measurement from each, and calculated their means and varience.
 *
 * Based on the work by Tomas Kalibera and Richard Jones. See their paper
 * "Quantifying Performance Changes with Effect Size Confidence Intervals", section 6.2,
 * formula "Quantifying Performance Change".
 *
 * However, it simplifies it to only assume one level of benchmarks, not multiple levels.
 * If you do have multiple levels, simply use the mean of the lower levels as your data,
 * like they do in the paper.
 *
 * @param oldSystem The old system we measured
 * @param newSystem The new system we measured
 * @param n The number of samples from each system (must be equal)
 * @param confidenceInterval The confidence interval for the results.
 *  The default is a 95% confidence interval (95% of the time the true mean will be
 *  between the resulting mean +- the resulting CI)
 */
export function performanceChange(
  { mean: y_o, variance: s_o }: { mean: number; variance: number },
  { mean: y_n, variance: s_n }: { mean: number; variance: number },
  n: number,
  confidenceInterval: number = 0.95
): { mean: number; confidenceInterval: number } {
  const dof = n - 1;
  const t = quantile(1 - (1 - confidenceInterval) / 2, dof);
  const oldFactor = sq(y_o) - (sq(t) * s_o) / n;
  const newFactor = sq(y_n) - (sq(t) * s_n) / n;
  const meanNum = y_o * y_n;
  const ciNum = Math.sqrt(sq(y_o * y_n) - newFactor * oldFactor);
  return {
    mean: meanNum / oldFactor,
    confidenceInterval: ciNum / oldFactor
  };
}

/**
 * Compute the performance change based on a number of old and new measurements.
 */
export function performanceChangeFromData(
  old: number[],
  new_: number[],
  confidenceInterval: number = 0.95
): { mean: number; confidenceInterval: number } {
  const n = old.length;
  if (n !== new_.length) {
    throw new Error('Data have different length');
  }
  return performanceChange(
    { mean: mean(...old), variance: variance(...old) },
    { mean: mean(...new_), variance: variance(...new_) },
    n,
    confidenceInterval
  );
}

/**
 * Format a performance changes like `between 20.1% slower and 30.3% faster`
 */
function formatChange({
  mean,
  confidenceInterval
}: {
  mean: number;
  confidenceInterval: number;
}): string {
  return `between ${formatPercent(
    mean + confidenceInterval
  )} and ${formatPercent(mean - confidenceInterval)}`;
}

function formatPercent(percent: number): string {
  if (percent < 1) {
    return `${((1 - percent) * 100).toFixed(1)}% faster`;
  }
  return `${((percent - 1) * 100).toFixed(1)}% slower`;
}

/**
 * Reproduce examples from paper, and verify we have implemented things correctly.
 */
export function tests() {
  assertAboutEqual(quantile(1 - 0.05 / 2, 2), 4.3, 'quantile');

  const paperResult = {
    mean: 68.3 / 74.5,
    confidenceInterval: 60.2 / 70.2
  };
  assertResultsEqual(
    performanceChange(
      { variance: 5.8, mean: 10.5 },
      { variance: 4.6, mean: 6.5 },
      3,
      0.95
    ),
    paperResult,
    'performanceChange'
  );

  //   Data from table V, uses means of top level
  assertResultsEqual(
    performanceChangeFromData(
      [mean(9, 11, 5, 6), mean(16, 13, 12, 8), mean(15, 7, 10, 14)],
      [mean(10, 12, 6, 7), mean(9, 1, 11, 4), mean(8, 5, 3, 2)],
      0.95
    ),
    paperResult,
    'performanceChangeFromData'
  );
}

function assertResultsEqual(
  l: {
    mean: number;
    confidenceInterval: number;
  },
  r: { mean: number; confidenceInterval: number },
  message: string
) {
  assertAboutEqual(l.mean, r.mean, `${message}: means`);
  assertAboutEqual(
    r.confidenceInterval,
    r.confidenceInterval,
    `${message}: confidence interval`
  );
}

function assertAboutEqual(x: number, y: number, msg: string): void {
  console.assert(Math.abs(x - y) <= 0.005, `${msg}: ${x} != ${y}`);
}

function sq(x: number): number {
  return Math.pow(x, 2);
}

function mean(...x: number[]): number {
  return meanpw(x.length, x, 1);
}

function variance(...x: number[]): number {
  return variancepn(x.length, 1, x, 1);
}
