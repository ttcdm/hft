"""5C (R1-109): the corpus feature and late-peak studies score every launch that was tradable at the decision point, not only those that
trade again later. Builds a fixture clean.duckdb (the tables build_clean_db.py writes) and tokens.parquet, and runs the real scripts.
Run: pip install duckdb pandas pyarrow tabulate pytest, then python3 -m pytest tests/hfcorpus (not part of npm test)."""
import os, subprocess, sys
import duckdb, pandas as pd, pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
T0 = pd.Timestamp('2026-06-10', tz='UTC')


def build(tmp, trades, tokens):
    """trades: (mint, minutes since launch, is_buy, price, wallet); writes the duckdb tables build_clean_db.py makes, and tokens.parquet"""
    db = os.path.join(tmp, 'clean.duckdb')
    tr = pd.DataFrame([dict(mint=m, ts=int((tokens[m]['detected_at'] + pd.Timedelta(minutes=tm)).timestamp() * 1000), tmin=float(tm), is_buy=b, sol=0.5, tok=1000.0, w=w,
                            price=p, curve_pct=10.0, is_creator=False) for (m, tm, b, p, w) in trades])
    c = duckdb.connect(db)
    c.execute('create table tr as select * from tr')
    c.execute("create table launch as select mint, count(*) n, min(tmin) first_min, max(tmin) last_min, arg_min(price, ts) ref_price, max(price) peak_price, arg_max(tmin, price) peak_min from tr group by mint")
    c.close()
    tk = pd.DataFrame([dict(mint=m, symbol=m, creator='c' + m, detected_at=v['detected_at'], graduated_at=v.get('graduated_at'), dev_buy_pct_corrected=0.0, initial_buy_sol=0.0,
                            creator_past_tokens=0, creator_past_rugs=0, is_mayhem_mode=False, initial_holder_count=1) for m, v in tokens.items()])
    tk['graduated_at'] = pd.to_datetime(tk['graduated_at'], utc=True)
    tp = os.path.join(tmp, 'tokens.parquet'); tk.to_parquet(tp)
    return db, tp


def run(script, *args):
    subprocess.run([sys.executable, '-I', os.path.join(ROOT, 'scripts', 'hfcorpus', script), *args], check=True, capture_output=True, text=True, cwd=ROOT)


def ten_launches(cp_min, after_min):
    """10 launches trading before the checkpoint (5 buyers each); 5 never trade again, 4 trade on flat, 1 doubles; plus one that graduates before the checkpoint"""
    trades, tokens = [], {}
    for i in range(11):
        m = f'L{i}'
        tokens[m] = dict(detected_at=T0 + pd.Timedelta(days=i * 4))  # both sides of the Jul 5 split
        for k in range(5):
            trades.append((m, cp_min - 1.5 + k * 0.2, True, 1.0, f'w{i}-{k}'))
        if 1 <= i <= 4:
            trades.append((m, after_min, True, 1.2, f'x{i}'))
        if i == 0:
            trades.append((m, after_min, True, 2.5, 'x0'))
        if i == 10:
            tokens[m]['graduated_at'] = tokens[m]['detected_at'] + pd.Timedelta(minutes=cp_min - 0.5)
    return trades, tokens


def test_feature_study_base_rate_counts_launches_that_never_trade_again(tmp_path):
    trades, tokens = ten_launches(2, 5)
    db, tp = build(str(tmp_path), trades, tokens)
    pd.DataFrame([dict(mint=m, verdict='READY', score=50) for m in tokens]).to_csv(tmp_path / 'scores.csv', index=False)
    run('study_features.py', '--db', db, '--tokens', tp, '--scores', str(tmp_path / 'scores.csv'), '--out', str(tmp_path / 'out'))
    pop = pd.read_csv(tmp_path / 'out' / 'population.csv').iloc[0]
    assert pop.launches == 10          # the graduated one is out, the five quiet ones are in
    assert pop.no_trade_after_2min == 5
    assert pop.reached_2x_in_10min == 1
    assert pop.base_rate == pytest.approx(0.1)


def test_late_study_second_wave_base_rate_counts_launches_that_never_trade_again(tmp_path):
    trades, tokens = ten_launches(30, 45)
    db, tp = build(str(tmp_path), trades, tokens)
    run('study_late.py', '--db', db, '--tokens', tp, '--out', str(tmp_path / 'out'))
    sig = pd.read_csv(tmp_path / 'out' / 'second_wave_signals.csv')
    at30 = sig[sig.cp_min == 30].iloc[0]
    assert at30.of_tradable_at_cp == 10
    assert at30.of_which_no_later_trade == 5
    assert at30.base_rate_2x_after == pytest.approx(0.1)
