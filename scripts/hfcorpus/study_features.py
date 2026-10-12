#!/usr/bin/env python3
"""S197c step 4: which first-2-minute facts separate launches that reach 2x within the next 10 minutes (from the 2-minute price) from those that do not?
   python3 scripts/hfcorpus/study_features.py --db clean.duckdb --tokens tokens.parquet --scores scores.csv --out DIR"""
import argparse, duckdb, pandas as pd, numpy as np, os
ap = argparse.ArgumentParser(); ap.add_argument('--db', required=True); ap.add_argument('--tokens', required=True); ap.add_argument('--scores', required=True); ap.add_argument('--out', required=True); a = ap.parse_args()
os.makedirs(a.out, exist_ok=True)
c = duckdb.connect(a.db, read_only=True); c.execute('set threads=4')
md = []
def emit(title, df, note=None):
    md.append(f'\n### {title}\n')
    if note: md.append(note + '\n')
    md.append(df.to_markdown(index=False, floatfmt='.3g') + '\n'); df.to_csv(os.path.join(a.out, title.lower().replace(' ', '_').replace('/', '_').replace(':', '').replace('(', '').replace(')', '').replace(',', '')[:70] + '.csv'), index=False)

q = """
with f as (
 select mint,
  count(*) filter (where tmin < 2) n_trades,
  count(*) filter (where tmin < 2 and is_buy) n_buys,
  count(distinct w) filter (where tmin < 2 and is_buy) uniq_buyers,
  coalesce(sum(sol) filter (where tmin < 2 and is_buy), 0) buy_sol,
  coalesce(sum(sol) filter (where tmin < 2 and not is_buy), 0) sell_sol,
  bool_or(tmin < 2 and is_creator and not is_buy) creator_sold,
  min(tmin) * 60 first_trade_s,
  arg_max(price, ts) filter (where tmin < 2) px2,
  arg_max(curve_pct, ts) filter (where tmin < 2) curve2,
  min(price) filter (where tmin < 2) low2,
  coalesce(sum(case when is_buy then sol else -sol end) filter (where tmin >= 1.5 and tmin < 2), 0) net_last30s,
  coalesce(sum(case when is_buy then sol else -sol end) filter (where tmin >= 1 and tmin < 1.5), 0) net_prev30s,
  max(price) filter (where tmin >= 2 and tmin < 12) fwd_peak,
  count(*) filter (where tmin >= 2) n_after
 from tr group by mint having count(*) filter (where tmin < 2) > 0),
top as (select mint, max(s) top_buyer_sol from (select mint, w, sum(sol) s from tr where tmin < 2 and is_buy group by mint, w) group by mint)
select f.*, top.top_buyer_sol, l.ref_price from f join launch l using (mint) left join top using (mint)"""
d = c.execute(q).df()
t = duckdb.connect().execute(f"select mint, detected_at, dev_buy_pct_corrected dev_buy_pct, initial_buy_sol, creator_past_tokens, creator_past_rugs, is_mayhem_mode::int mayhem, initial_holder_count from read_parquet('{a.tokens}')").df()
d = d.merge(t, on='mint', how='left')
s = pd.read_csv(a.scores); d = d.merge(s[['mint', 'verdict', 'score']], on='mint', how='left')
d = d[d.n_after > 0].copy()          # a later trade exists, so a fill after the 2-minute mark was possible
d['hit'] = (d.fwd_peak / d.px2 >= 2).astype(int)
d['buy_ratio'] = d.n_buys / d.n_trades
d['top_buyer_share'] = d.top_buyer_sol / d.buy_sol.replace(0, np.nan)
d['net_flow'] = d.buy_sol - d.sell_sol
d['px_mult_2m'] = d.px2 / d.ref_price
d['flow_rising'] = (d.net_last30s - d.net_prev30s)
d['creator_sold'] = d.creator_sold.astype(float)
base = d.hit.mean()
emit('Population', pd.DataFrame([dict(launches=len(d), reached_2x_in_10min=int(d.hit.sum()), base_rate=base, with_confluence_score=int(d.score.notna().sum()), hit_rate_with_score=d[d.score.notna()].hit.mean())]),
     'Launches with a trade in the first 2 min and a later trade. Hit = highest price in minutes 2-12 >= 2x the price at the 2-minute mark.')

feats = ['n_trades', 'n_buys', 'buy_ratio', 'uniq_buyers', 'buy_sol', 'sell_sol', 'net_flow', 'top_buyer_share', 'creator_sold', 'first_trade_s', 'curve2', 'px_mult_2m', 'net_last30s', 'flow_rising',
         'dev_buy_pct', 'initial_buy_sol', 'creator_past_tokens', 'creator_past_rugs', 'mayhem', 'initial_holder_count', 'score']
def auc(x, y):
    m = x.notna(); x, y = x[m], y[m]
    if y.sum() == 0 or y.sum() == len(y) or x.nunique() < 2: return np.nan
    r = x.rank(); n1 = y.sum(); n0 = len(y) - n1
    return (r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)
# S197d: the last 10 days (launches from 2026-07-05 UTC on) are held out; quintile cut points come from the train part only
cut = pd.Timestamp('2026-07-05', tz='UTC')
d['is_test'] = d.detected_at >= cut
tr_, te_ = d[~d.is_test], d[d.is_test]
base_tr, base_te = tr_.hit.mean(), te_.hit.mean()
rows = []
for f in feats:
    row = dict(feature=f, coverage_train=tr_[f].notna().mean(), auc_train=auc(tr_[f], tr_.hit), auc_test=auc(te_[f], te_.hit))
    xs = tr_[f].dropna()
    if xs.nunique() > 4:
        hi, lo = xs.quantile(0.8), xs.quantile(0.2)
        for nm, fn in (('top quintile', lambda x: x >= hi), ('bottom quintile', lambda x: x <= lo)):
            ctr, cte = fn(tr_[f]) & tr_[f].notna(), fn(te_[f]) & te_[f].notna()
            row[f'lift_{nm}_train'] = tr_.hit[ctr].mean() / base_tr; row[f'lift_{nm}_test'] = te_.hit[cte].mean() / base_te if cte.sum() else np.nan
    rows.append(row)
res = pd.DataFrame(rows); res['abs_auc_edge'] = (res.auc_train - 0.5).abs()
emit('Feature separation', res.sort_values('abs_auc_edge', ascending=False).drop(columns='abs_auc_edge'), f'AUC 0.5 = no separation. Train = launches before Jul 5 ({len(tr_)} launches, base rate {base_tr:.3f}); test = Jul 5 on ({len(te_)} launches, base rate {base_te:.3f}). Quintile cut points come from train only; ties can make a quintile larger than 20%.')

# the score's own bands
sc = d[d.score.notna()].copy()
sc['band'] = pd.cut(sc.score, [-1, 9, 19, 29, 39, 49, 59, 69, 100], labels=['0-9', '10-19', '20-29', '30-39', '40-49', '50-59', '60-69', '70+'])
bands = sc.groupby(['band', 'is_test'], observed=True).agg(launches=('hit', 'size'), hit_rate=('hit', 'mean')).reset_index()
bands['part'] = np.where(bands.is_test, 'test (Jul 5 on)', 'train'); bands['lift'] = bands.hit_rate / np.where(bands.is_test, base_te, base_tr)
emit('Confluence score bands', bands.drop(columns='is_test')[['part', 'band', 'launches', 'hit_rate', 'lift']].sort_values(['part', 'band']), 'Score at the end of the 2-minute watch window (replay, SOL/USD 150).')
sc['period'] = pd.cut(sc.detected_at, [pd.Timestamp('2026-06-01', tz='UTC'), pd.Timestamp('2026-06-25', tz='UTC'), pd.Timestamp('2026-07-04', tz='UTC'), pd.Timestamp('2026-08-01', tz='UTC')], labels=['Jun 5-24', 'Jun 25-Jul 3', 'Jul 4-14'], right=False)
per = sc.groupby(['period', 'band'], observed=True).agg(launches=('hit', 'size'), hit_rate=('hit', 'mean')).reset_index()
d['period'] = pd.cut(d.detected_at, [pd.Timestamp('2026-06-01', tz='UTC'), pd.Timestamp('2026-06-25', tz='UTC'), pd.Timestamp('2026-07-04', tz='UTC'), pd.Timestamp('2026-08-01', tz='UTC')], labels=['Jun 5-24', 'Jun 25-Jul 3', 'Jul 4-14'], right=False)
emit('Score bands by period', per, 'Same hit definition, split at the dates where the corpus changes (see late_rule.md).')
emit('Base rate and activity by period', d.groupby('period', observed=True).agg(launches=('hit', 'size'), hit_rate=('hit', 'mean'), median_trades_first_2min=('n_trades', 'median'), median_unique_buyers=('uniq_buyers', 'median'), median_curve_pct_2min=('curve2', 'median')).reset_index())
open(os.path.join(a.out, 'study_features.md'), 'w').write('# First-2-minute feature study (39-day corpus)\n' + '\n'.join(md))
print('\n'.join(md))
