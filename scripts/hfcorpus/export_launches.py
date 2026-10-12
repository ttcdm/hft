#!/usr/bin/env python3
"""
S197: turns the Slinky21/Pumpfun_Memecoin_Corpus parquet files (tokens.parquet + trades/*.parquet) into one JSON line per launch, in the shape
scripts/hfcorpus/replay.ts feeds to the real replay (RecordedLaunch). Needs `pip install duckdb pytz`.

  python3 scripts/hfcorpus/export_launches.py --data-dir DIR --out launches.jsonl [--min-trades 1] [--limit N] [--sample-pct P]

Cleaning follows the corpus's KNOWN_ISSUES.md: the System Program wallet is dropped (3.3), rows whose sol_amount is NULL or disagrees with
token_amount x (reserve-derived price) by more than 100x either way are dropped (3.1, 3.2), and rows with impossible reserves are dropped.
Each output line: {mint, symbol, creator, mayhem, t0, graduated, trades: [[tsMs, isBuy, solAmount, tokenAmount, wallet, vSolLamports, vTokenRaw, sig], ...]}
"""
import argparse, json, sys
import duckdb

SYSTEM_PROGRAM = 'BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s'
V_SOL_INIT, V_TOK_INIT = 30_000_000_000, 1_073_000_000_000_000

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--data-dir', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--min-trades', type=int, default=1)
    ap.add_argument('--limit', type=int, default=0, help='stop after N launches (0 = all)')
    ap.add_argument('--sample-pct', type=float, default=100.0, help='keep this %% of launches, chosen by a stable hash of the mint')
    a = ap.parse_args()
    con = duckdb.connect()
    con.execute("set threads=4")
    d = a.data_dir
    con.execute(f"""
      create temp table clean as
      select t.mint, t.event_time, t.is_buy, t.sol_amount, t.token_amount, t.user_wallet, t.v_sol_bonding_curve v_sol, t.v_tokens_bonding_curve v_tok, t.tx_signature sig
      from read_parquet('{d}/trades/*.parquet') t
      where t.user_wallet <> '{SYSTEM_PROGRAM}' and t.sol_amount > 0 and t.token_amount > 0
        and t.v_sol_bonding_curve between 29900000000 and 200000000000 and t.v_tokens_bonding_curve between 270000000000000 and 1080000000000000
        and t.sol_amount / (t.token_amount * (t.v_sol_bonding_curve / t.v_tokens_bonding_curve / 1000.0)) between 0.01 and 100
        and (hash(t.mint) % 10000) < {int(a.sample_pct * 100)}
    """)
    con.execute(f"""
      create temp table keep as select mint, count(*) n from clean group by 1 having count(*) >= {a.min_trades}
    """)
    toks = {r[0]: r for r in con.execute(f"select mint, symbol, creator, is_mayhem_mode, epoch_ms(detected_at), graduated_at is not null from read_parquet('{d}/tokens.parquet')").fetchall()}
    cur = con.execute(f"""
      select c.mint, k.n, c.event_time, c.is_buy, c.sol_amount, c.token_amount, c.user_wallet, c.v_sol, c.v_tok, c.sig
      from clean c join keep k using (mint) order by c.mint, c.event_time, c.v_tok desc
    """)
    out = open(a.out, 'w')
    cur_mint, trades, n_out, n_trades = None, [], 0, 0

    def flush() -> None:
        nonlocal trades, n_out, n_trades
        if cur_mint is None or not trades: return
        t = toks.get(cur_mint)
        if t is None: return
        _, symbol, creator, mayhem, t0, grad = t
        # trades never precede the launch they belong to
        rows = [[max(int(tr[0]), int(t0)), tr[1], tr[2], tr[3], tr[4], int(tr[5]), int(tr[6]), tr[7]] for tr in trades]
        out.write(json.dumps({'mint': cur_mint, 'symbol': symbol or '?', 'creator': creator, 'mayhem': bool(mayhem), 't0': int(t0), 'graduated': bool(grad), 'trades': rows}, separators=(',', ':')) + '\n')
        n_out += 1; n_trades += len(rows)

    while True:
        chunk = cur.fetchmany(200_000)
        if not chunk: break
        for r in chunk:
            if r[0] != cur_mint:
                flush(); trades = []; cur_mint = r[0]
                if a.limit and n_out >= a.limit: chunk = []; break
            trades.append([r[2].timestamp() * 1000, bool(r[3]), float(r[4]), float(r[5]), r[6], r[7], r[8], r[9]])
        if not chunk: break
    else:
        pass
    if not (a.limit and n_out >= a.limit): flush()
    out.close()
    print(f'wrote {n_out} launches, {n_trades} trades -> {a.out}', file=sys.stderr)
    return 0

if __name__ == '__main__':
    sys.exit(main())
