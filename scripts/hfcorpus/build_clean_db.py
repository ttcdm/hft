#!/usr/bin/env python3
"""S197c: builds a duckdb file with the cleaned trades (same filters as export_launches.py) plus per-trade minutes since launch, price and curve progress.
   python3 scripts/hfcorpus/build_clean_db.py --data-dir DIR --db clean.duckdb"""
import argparse, duckdb
SP = 'BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s'
ap = argparse.ArgumentParser(); ap.add_argument('--data-dir', required=True); ap.add_argument('--db', required=True); a = ap.parse_args()
c = duckdb.connect(a.db); c.execute('set threads=4')
c.execute(f"""
create or replace table tr as
select t.mint, epoch_ms(t.event_time) ts, (epoch_ms(t.event_time) - epoch_ms(k.detected_at)) / 60000.0 tmin, t.is_buy, t.sol_amount sol, t.token_amount tok, t.user_wallet w,
       t.v_sol_bonding_curve / t.v_tokens_bonding_curve / 1000.0 price, (793100000000000.0 - (t.v_tokens_bonding_curve - 279900000000000.0)) / 793100000000000.0 * 100 curve_pct,
       (t.user_wallet = k.creator) is_creator
from read_parquet('{a.data_dir}/trades/*.parquet') t join read_parquet('{a.data_dir}/tokens.parquet') k using (mint)
where t.user_wallet <> '{SP}' and t.sol_amount > 0 and t.token_amount > 0
  and t.v_sol_bonding_curve between 29900000000 and 200000000000 and t.v_tokens_bonding_curve between 270000000000000 and 1080000000000000
  and t.sol_amount / (t.token_amount * (t.v_sol_bonding_curve / t.v_tokens_bonding_curve / 1000.0)) between 0.01 and 100
""")
c.execute("create or replace table launch as select mint, count(*) n, min(tmin) first_min, max(tmin) last_min, arg_min(price, ts) ref_price, max(price) peak_price, arg_max(tmin, price) peak_min from tr group by mint")
print(c.execute("select count(*) from tr").fetchone(), c.execute("select count(*) from launch").fetchone())
