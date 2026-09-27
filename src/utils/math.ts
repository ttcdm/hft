// Quantitative & Mathematical Models for Apex Quant HFT Workstation

/**
 * Avellaneda-Stoikov Reservation Price
 * r(s, q, t) = s - q * gamma * sigma^2 * (T - t)
 */
export function calculateReservationPrice(
  midPrice: number,
  inventoryQ: number,
  gamma: number = 0.1,
  sigma2: number = 0.05,
  timeRemaining: number = 0.5
): number {
  return midPrice - inventoryQ * gamma * sigma2 * timeRemaining;
}

/**
 * Avellaneda-Stoikov Optimal Spread
 * delta_a + delta_b = gamma * sigma^2 * (T - t) + (2 / gamma) * ln(1 + gamma / kappa)
 */
export function calculateOptimalSpread(
  gamma: number = 0.1,
  sigma2: number = 0.05,
  timeRemaining: number = 0.5,
  kappa: number = 1.5
): number {
  const inventoryPenalty = gamma * sigma2 * timeRemaining;
  const liquiditySpread = (2 / gamma) * Math.log(1 + gamma / kappa);
  return inventoryPenalty + liquiditySpread;
}

/**
 * Order Flow Imbalance (OFI)
 * OFI = (Bid Size - Ask Size) / (Bid Size + Ask Size)
 * Output bounded between -1.0 (sell pressure) and +1.0 (buy pressure)
 */
export function calculateOFI(bidSize: number, askSize: number): number {
  const sum = bidSize + askSize;
  if (sum === 0) return 0;
  return (bidSize - askSize) / sum;
}

/**
 * Theoretical Micro-Price based on L1 Queue Weighting
 * P_micro = P_bid * (Ask Size / Total) + P_ask * (Bid Size / Total)
 */
export function calculateMicroPrice(
  bidPrice: number,
  askPrice: number,
  bidSize: number,
  askSize: number
): number {
  const total = bidSize + askSize;
  if (total === 0) return (bidPrice + askPrice) / 2;
  return bidPrice * (askSize / total) + askPrice * (bidSize / total);
}

/**
 * Synthetic Network Degradation & Slippage Multiplier
 */
export function calculateNetworkDegradation(
  baseLatency: number,
  jitterMs: number,
  packetLossPct: number,
  profile: 'GAUSSIAN' | 'PARETO_BURST' | 'MICROWAVE_FADE' | 'CIRCUIT_BREAKER',
  baseSlippageBps: number = 1.2
): { effectiveLatencyMs: number; realizedSlippageBps: number; isDropped: boolean } {
  if (profile === 'CIRCUIT_BREAKER') {
    return {
      effectiveLatencyMs: 999.9,
      realizedSlippageBps: 85.0,
      isDropped: true,
    };
  }

  // Gaussian noise via Box-Muller transform
  const u1 = Math.max(0.0001, Math.random());
  const u2 = Math.random();
  const normalRand = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);

  let noise = normalRand * jitterMs;

  if (profile === 'PARETO_BURST') {
    // Occasional heavy tail spike
    if (Math.random() < 0.15) {
      noise += Math.random() * jitterMs * 6.0;
    }
  } else if (profile === 'MICROWAVE_FADE') {
    // Weather fading cyclical latency
    noise += Math.sin(Date.now() / 1500) * (jitterMs * 2.5) + (jitterMs * 1.5);
  }

  const effectiveLatency = Math.max(0.24, baseLatency + noise);
  const dropCheck = Math.random() * 100 < packetLossPct;

  const lossRatio = packetLossPct / 100;
  const realizedSlippage =
    baseSlippageBps * (1 + effectiveLatency / 2.0) * (1 + lossRatio * 4.5);

  return {
    effectiveLatencyMs: Number(effectiveLatency.toFixed(3)),
    realizedSlippageBps: Number(realizedSlippage.toFixed(2)),
    isDropped: dropCheck,
  };
}

/**
 * Monte Carlo Multi-Path Future Simulation
 * Generates 1,000 paths over 30 discrete forward intervals using Geometric Brownian Motion with jump diffusion
 */
export function generateMonteCarloTrajectories(
  initialPrice: number,
  steps: number = 30,
  paths: number = 1000,
  drift: number = 0.0002,
  volatility: number = 0.008
): {
  steps: number[];
  p05: number[];
  p50: number[];
  p95: number[];
  samplePaths: number[][]; // 8 representative paths for rendering
} {
  const sampleIndices = [0, 42, 118, 250, 480, 720, 888, 999];
  const stepLabels = Array.from({ length: steps }, (_, i) => i + 1);

  // Matrix [step][path]
  const matrix: number[][] = Array.from({ length: steps }, () => []);

  for (let p = 0; p < paths; p++) {
    let price = initialPrice;
    for (let s = 0; s < steps; s++) {
      const u1 = Math.max(0.0001, Math.random());
      const u2 = Math.random();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);

      // Jump diffusion
      const jump = Math.random() < 0.03 ? (Math.random() - 0.5) * volatility * 4 : 0;
      price = price * Math.exp((drift - 0.5 * volatility * volatility) + volatility * z + jump);
      matrix[s].push(price);
    }
  }

  const p05: number[] = [];
  const p50: number[] = [];
  const p95: number[] = [];

  for (let s = 0; s < steps; s++) {
    const sorted = [...matrix[s]].sort((a, b) => a - b);
    p05.push(sorted[Math.floor(paths * 0.05)]);
    p50.push(sorted[Math.floor(paths * 0.50)]);
    p95.push(sorted[Math.floor(paths * 0.95)]);
  }

  const samplePaths: number[][] = sampleIndices.map(pIdx => {
    return matrix.map(stepArray => stepArray[pIdx]);
  });

  return {
    steps: stepLabels,
    p05,
    p50,
    p95,
    samplePaths,
  };
}

/**
 * Format microsecond timestamp: HH:MM:SS.ffffff
 */
export function formatMicrosecondTimestamp(timestamp: number = Date.now()): string {
  const d = new Date(timestamp);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  const micros = String(Math.floor(Math.random() * 900 + 100));
  return `${hh}:${mm}:${ss}.${ms}${micros}`;
}
