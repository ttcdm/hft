#!/usr/bin/env python3
"""S197c step 3: do launches that peak late (>= 180 min, and 30-180 min) look different at 30 / 60 / 120 min from the typical coin, and does a
'second wave' signal show before the peak?   python3 scripts/hfcorpus/study_late.py --db clean.duckdb --out DIR"""
import argparse, duckdb, pandas as pd, os
ap = argparse.ArgumentParser(); ap.add_argument('--db', required=True); ap.add_argument('--out', required=True); a = ap.parse_args()
os.makedirs(a.out, exist_ok=True)
c = duckdb.connect(a.db, read_only=True); c.execute('set threads=4')
md = []
def emit(title, df, note=None):
    md.append(f'\n### {title}\n'); 
    if note: md.append(note + '\n')
    md.append(df.to_markdown(index=False, floatfmt='.3g') + '\n')
    df.to_csv(os.path.join(a.out, title.lower().replace(' ', '_').replace('/', '_').replace(':', '').replace('(', '').replace(')', '').replace(',', '')[:70] + '.csv'), index=False)

c.execute("create temp table grp as select mint, n, first_min, last_min, ref_price, peak_price, peak_min, case when peak_price > ref_price * 1.0000001 and peak_min >= 180 then 'late (peak >= 180 min)' when peak_price > ref_price * 1.0000001 and peak_min >= 30 then 'mid (peak 30-180 min)' else 'other' end g from launch where n >= 2")
emit('Group sizes', c.execute("select g, count(*) launches, round(median(peak_price / ref_price), 2) median_peak_multiple, round(median(last_min), 1) median_last_trade_min from grp group by 1 order by 1").df())

CPS = [30, 60, 120]
frames = []
for cp in CPS:
    q = f"""
    select '{cp}' cp, t.mint,
      arg_max(price, ts) filter (where tmin < {cp}) px_cp,
      arg_max(curve_pct, ts) filter (where tmin < {cp}) curve_cp,
      count(*) filter (where tmin < {cp}) trades_0_cp,
      count(*) filter (where tmin >= {cp - 10} and tmin < {cp} and is_buy) buys_r10,
      count(*) filter (where tmin >= {max(0, cp - 30)} and tmin < {cp - 10} and is_buy) buys_p20,
      count(distinct w) filter (where tmin >= {cp - 10} and tmin < {cp} and is_buy) uniq_buyers_r10,
      coalesce(sum(case when is_buy then sol else -sol end) filter (where tmin >= {cp - 10} and tmin < {cp}), 0) net_r10,
      coalesce(sum(case when is_buy then sol else -sol end) filter (where tmin < {cp}), 0) net_cum,
      max(price) filter (where tmin >= {cp}) fwd_peak,
      count(*) filter (where tmin >= {cp}) trades_after
    from tr t group by t.mint having count(*) filter (where tmin < {cp}) > 0"""
    d = c.execute(q).df()
    frames.append(d)
d = pd.concat(frames)
g = c.execute("select mint, g, ref_price, peak_min from grp").df()
d = d.merge(g, on='mint', how='inner')
d['px_mult_vs_launch'] = d.px_cp / d.ref_price
d['buys_per_min_r10'] = d.buys_r10 / 10.0
d['buys_per_min_p20'] = d.buys_p20 / 20.0
d['fwd_mult'] = d.fwd_peak / d.px_cp
d['survivor'] = d.trades_after > 0
d.to_parquet(os.path.join(a.out, 'checkpoint_features.parquet'))

rows = []
for cp in CPS:
    x = d[d.cp == str(cp)]
    pops = {'all launches (>=2 trades) with a trade before cp': x, 'survivors (also trade at/after cp)': x[x.survivor], 'late peakers (>=180 min)': x[x.g.str.startswith('late')], 'mid peakers (30-180 min)': x[x.g.str.startswith('mid')]}
    for name, p in pops.items():
        if len(p) == 0: continue
        rows.append(dict(cp_min=cp, population=name, launches=len(p), curve_pct=p.curve_cp.median(), price_x_vs_launch=p.px_mult_vs_launch.median(), buys_per_min_last10=p.buys_per_min_r10.median(), buys_per_min_prior20=p.buys_per_min_p20.median(),
                         unique_buyers_last10=p.uniq_buyers_r10.median(), net_flow_last10_sol=p.net_r10.median(), net_flow_cum_sol=p.net_cum.median(), trades_before_cp=p.trades_0_cp.median(), share_any_buy_last10=(p.buys_r10 > 0).mean()))
emit('Medians at each checkpoint', pd.DataFrame(rows))

# second-wave signals: among survivors at cp, does the flag pick out launches that later go on to >=2x (from the price at cp)?
sig_rows = []
for cp in CPS:
    x = d[(d.cp == str(cp)) & d.survivor].copy()
    x['hit2x'] = x.fwd_mult >= 2
    x['late_peak'] = x.g.str.startswith('late')
    x['mid_or_late'] = x.g.str.startswith('late') | x.g.str.startswith('mid')
    flags = {
        'buys/min last 10 >= 2x prior 20 (and >= 0.5/min)': (x.buys_per_min_r10 >= 2 * x.buys_per_min_p20) & (x.buys_per_min_r10 >= 0.5),
        'net flow last 10 > 0 and >= 3 unique buyers': (x.net_r10 > 0) & (x.uniq_buyers_r10 >= 3),
        'net flow last 10 > 0.5 SOL': x.net_r10 > 0.5,
        'unique buyers last 10 >= 5': x.uniq_buyers_r10 >= 5,
        'price within 25% of launch price or lower and buys last 10 >= 3': (x.px_mult_vs_launch <= 1.25) & (x.buys_r10 >= 3),
    }
    base = x.hit2x.mean()
    for name, f in flags.items():
        if f.sum() == 0: continue
        hr = x.hit2x[f].mean()
        sig_rows.append(dict(cp_min=cp, signal=name, flagged=int(f.sum()), of_survivors=len(x), base_rate_2x_after=base, flagged_rate_2x_after=hr, lift=hr / base if base else None,
                             late_peak_share_flagged=x.late_peak[f].mean(), late_peak_share_all=x.late_peak.mean(), mid_or_late_share_flagged=x.mid_or_late[f].mean(), mid_or_late_share_all=x.mid_or_late.mean()))
emit('Second wave signals', pd.DataFrame(sig_rows), 'Population: launches still trading at/after the checkpoint. 2x after = highest later price >= 2x the price at the checkpoint.')
open(os.path.join(a.out, 'study_late.md'), 'w').write('# Late-peak study (39-day corpus)\n' + '\n'.join(md))
print('\n'.join(md))

# which early, simple facts pick out the late peakers at all (not only a second wave)?
rows = []
for cp in CPS:
    x = d[d.cp == str(cp)].copy(); x['late'] = x.g.str.startswith('late'); x['midlate'] = x.late | x.g.str.startswith('mid')
    base_l, base_m = x.late.mean(), x.midlate.mean()
    for name, f in {'curve progress >= 20%': x.curve_cp >= 20, 'curve progress >= 40%': x.curve_cp >= 40, 'curve progress >= 60%': x.curve_cp >= 60, 'cumulative net flow >= 5 SOL': x.net_cum >= 5,
                    'cumulative net flow >= 5 SOL and curve >= 40%': (x.net_cum >= 5) & (x.curve_cp >= 40), 'price >= 1.5x launch price': x.px_mult_vs_launch >= 1.5, 'trades before cp >= 30': x.trades_0_cp >= 30}.items():
        if f.sum() == 0: continue
        rows.append(dict(cp_min=cp, early_fact=name, flagged=int(f.sum()), of=len(x), late_peakers_in_flagged=int(x.late[f].sum()), late_peakers_total=int(x.late.sum()), precision_late=x.late[f].mean(), recall_late=x.late[f].sum() / max(1, x.late.sum()), lift_late=x.late[f].mean() / base_l, precision_mid_or_late=x.midlate[f].mean(), lift_mid_or_late=x.midlate[f].mean() / base_m))
emit('Early facts that pick out late peakers', pd.DataFrame(rows), 'Population: all launches (>=2 trades) with a trade before the checkpoint. Hindsight grouping, so this shows what separates them, not a tested trading rule.')
open(os.path.join(a.out, 'study_late.md'), 'w').write('# Late-peak study (39-day corpus)\n' + '\n'.join(md))
print(md[-2] + md[-1])
