// =====================================================================
// Prometheus метрики и телеметрия (Prometheus Metrics Exporter)
// =====================================================================

class MetricsRegistry {
  constructor(maxEntries = 5000) {
    this.maxEntries = maxEntries;
    this.counters = new Map();
    this.gauges = new Map();
    this.histograms = new Map();
  }

  _getKey(name, labels = {}) {
    const labelStr = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${String(v).slice(0, 64)}"`)
      .join(',');
    return labelStr ? `${name}{${labelStr}}` : name;
  }

  incCounter(name, labels = {}, value = 1) {
    const key = this._getKey(name, labels);
    if (!this.counters.has(key) && this.counters.size >= this.maxEntries) {
      const firstKey = this.counters.keys().next().value;
      this.counters.delete(firstKey);
    }
    const current = this.counters.get(key) || 0;
    this.counters.set(key, current + value);
  }

  setGauge(name, labels = {}, value = 0) {
    const key = this._getKey(name, labels);
    this.gauges.set(key, value);
  }

  incGauge(name, labels = {}, delta = 1) {
    const key = this._getKey(name, labels);
    const current = this.gauges.get(key) || 0;
    this.gauges.set(key, current + delta);
  }

  decGauge(name, labels = {}, delta = 1) {
    this.incGauge(name, labels, -delta);
  }

  observeHistogram(name, labels = {}, value = 0) {
    const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
    const keyPrefix = this._getKey(name, labels);

    if (!this.histograms.has(keyPrefix)) {
      this.histograms.set(keyPrefix, {
        sum: 0,
        count: 0,
        buckets: buckets.map(b => ({ le: b, count: 0 })),
      });
    }

    const hist = this.histograms.get(keyPrefix);
    hist.sum += value;
    hist.count += 1;

    for (const b of hist.buckets) {
      if (value <= b.le) {
        b.count += 1;
      }
    }
  }

  toPrometheusFormat() {
    const lines = [];

    // Counters
    for (const [key, val] of this.counters.entries()) {
      lines.push(`${key} ${val}`);
    }

    // Gauges
    for (const [key, val] of this.gauges.entries()) {
      lines.push(`${key} ${val}`);
    }

    // Histograms
    for (const [keyPrefix, hist] of this.histograms.entries()) {
      const match = keyPrefix.match(/^([a-zA-Z0-9_]+)(\{(.*)\})?$/);
      const name = match ? match[1] : keyPrefix;
      const existingLabels = match && match[3] ? match[3] + ',' : '';

      for (const b of hist.buckets) {
        lines.push(`${name}_bucket{${existingLabels}le="${b.le}"} ${b.count}`);
      }
      lines.push(`${name}_bucket{${existingLabels}le="+Inf"} ${hist.count}`);
      lines.push(`${name}_sum{${existingLabels.slice(0, -1)}} ${hist.sum.toFixed(6)}`);
      lines.push(`${name}_count{${existingLabels.slice(0, -1)}} ${hist.count}`);
    }

    return lines.join('\n') + '\n';
  }
}

const defaultRegistry = new MetricsRegistry();

module.exports = {
  MetricsRegistry,
  defaultRegistry,
};
