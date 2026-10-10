import React, { useState } from 'react';
import {
  ExternalLink,
  TrendingUp,
  Flame,
  Globe,
  Zap,
  Copy,
  Check,
  Compass,
  X,
  Share2,
  Send,
} from 'lucide-react';
import { getTokenExternalLinks, TokenLinkItem } from '../utils/tokenLinks';
import { useTradingMode } from '../utils/tradingMode';

interface TokenInlineExternalLinksProps {
  mintOrCa: string;
  symbol: string;
  name?: string;
  chain?: string;
  platform?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  onOpenModal?: () => void;
  compact?: boolean;
}

export const TokenInlineExternalLinks: React.FC<TokenInlineExternalLinksProps> = ({
  mintOrCa,
  symbol,
  name,
  chain = 'SOLANA',
  platform = 'PUMP_FUN',
  twitter,
  telegram,
  website,
  onOpenModal,
  compact = false,
}) => {
  const [copied, setCopied] = useState(false);
  const mode = useTradingMode();
  const links = getTokenExternalLinks({
    mintOrCa,
    symbol,
    name,
    chain,
    platform,
    twitter,
    telegram,
    website,
    cluster: mode.cluster,
  });

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!mintOrCa) return;
    navigator.clipboard.writeText(mintOrCa);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Get primary external services
  const dexLink = links.find((l) => l.id === 'dexscreener');
  const pumpLink = links.find((l) => l.id === 'pumpfun' && l.isAvailable);
  const gmgnLink = links.find((l) => l.id === 'gmgn' && l.isAvailable);
  const birdeyeLink = links.find((l) => l.id === 'birdeye' && l.isAvailable);
  const explorerLink = links.find((l) => l.id === 'solscan' && l.isAvailable);
  const photonLink = links.find((l) => l.id === 'photon' && l.isAvailable);

  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1">
      {/* DexScreener Link */}
      {dexLink && (
        <a
          href={dexLink.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 hover:border-cyan-400 transition-colors"
          title="Open real-time chart on DexScreener"
        >
          <TrendingUp className="w-2.5 h-2.5 text-cyan-400" />
          <span>DexScreener</span>
          <ExternalLink className="w-2 h-2 text-cyan-400 opacity-70" />
        </a>
      )}

      {/* Pump.fun Link */}
      {pumpLink && (
        <a
          href={pumpLink.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 hover:border-rose-400 transition-colors"
          title="Open bonding curve on Pump.fun"
        >
          <Flame className="w-2.5 h-2.5 text-rose-400" />
          <span>Pump.fun</span>
          <ExternalLink className="w-2 h-2 text-rose-400 opacity-70" />
        </a>
      )}

      {/* GMGN Link */}
      {gmgnLink && !compact && (
        <a
          href={gmgnLink.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 hover:border-emerald-400 transition-colors"
          title="Open smart money analytics on GMGN.ai"
        >
          <span>GMGN</span>
          <ExternalLink className="w-2 h-2 text-emerald-400 opacity-70" />
        </a>
      )}

      {/* Birdeye Link */}
      {birdeyeLink && !compact && (
        <a
          href={birdeyeLink.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold bg-blue-500/10 hover:bg-blue-500/20 text-blue-300 border border-blue-500/30 hover:border-blue-400 transition-colors"
          title="Open institutional analytics on Birdeye"
        >
          <Globe className="w-2.5 h-2.5 text-blue-400" />
          <span>Birdeye</span>
          <ExternalLink className="w-2 h-2 text-blue-400 opacity-70" />
        </a>
      )}

      {/* Solscan / Explorer Link */}
      {explorerLink && !compact && (
        <a
          href={explorerLink.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold bg-purple-500/10 hover:bg-purple-500/20 text-purple-300 border border-purple-500/30 hover:border-purple-400 transition-colors"
          title={`View contract on ${explorerLink.name}`}
        >
          <span>{explorerLink.name}</span>
          <ExternalLink className="w-2 h-2 text-purple-400 opacity-70" />
        </a>
      )}

      {/* Photon Link */}
      {photonLink && !compact && (
        <a
          href={photonLink.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:border-amber-400 transition-colors"
          title="Open in Photon SOL terminal"
        >
          <Zap className="w-2.5 h-2.5 text-amber-400" />
          <span>Photon</span>
          <ExternalLink className="w-2 h-2 text-amber-400 opacity-70" />
        </a>
      )}

      {/* Copy CA Button */}
      {mintOrCa && (
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 hover:border-slate-500 transition-colors"
          title="Copy contract / mint address"
        >
          {copied ? (
            <>
              <Check className="w-2.5 h-2.5 text-emerald-400" />
              <span className="text-emerald-400 font-bold">Copied!</span>
            </>
          ) : (
            <>
              <Copy className="w-2.5 h-2.5 text-slate-400" />
              <span>Copy CA</span>
            </>
          )}
        </button>
      )}

      {/* More / Launcher Modal Trigger */}
      {onOpenModal && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenModal();
          }}
          className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] font-mono bg-slate-800/80 hover:bg-slate-700 text-cyan-400 border border-slate-700 hover:border-cyan-500 transition-colors"
          title="View all external platforms and options"
        >
          <Compass className="w-2.5 h-2.5" />
          <span>All Sites ↗</span>
        </button>
      )}
    </div>
  );
};

interface TokenExternalLinksModalProps {
  isOpen: boolean;
  onClose: () => void;
  tokenData: {
    mintOrCa: string;
    symbol: string;
    name?: string;
    chain?: string;
    platform?: string;
    twitter?: string;
    telegram?: string;
    website?: string;
    priceUsd?: number;
    unrealizedPnlPct?: number;
  } | null;
}

export const TokenExternalLinksModal: React.FC<TokenExternalLinksModalProps> = ({
  isOpen,
  onClose,
  tokenData,
}) => {
  const [copied, setCopied] = useState(false);
  const mode = useTradingMode();

  if (!isOpen || !tokenData) return null;

  const links = getTokenExternalLinks({
    cluster: mode.cluster,
    mintOrCa: tokenData.mintOrCa,
    symbol: tokenData.symbol,
    name: tokenData.name,
    chain: tokenData.chain,
    platform: tokenData.platform,
    twitter: tokenData.twitter,
    telegram: tokenData.telegram,
    website: tokenData.website,
  });

  const handleCopyCa = () => {
    if (!tokenData.mintOrCa) return;
    navigator.clipboard.writeText(tokenData.mintOrCa);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
      <div className="bg-[#0D1322] border border-cyan-500/40 rounded-2xl w-full max-w-xl overflow-hidden shadow-2xl font-mono text-slate-200">
        {/* Modal Header */}
        <div className="flex items-center justify-between p-4 bg-[#090D17] border-b border-[#1E293B]">
          <div className="flex items-center space-x-2.5">
            <div className="p-2 rounded-xl bg-cyan-500/15 border border-cyan-500/30 text-cyan-400">
              <Compass className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h3 className="text-base font-bold text-white tracking-wide">
                  ${tokenData.symbol}
                </h3>
                {tokenData.name && (
                  <span className="text-xs text-slate-400">({tokenData.name})</span>
                )}
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-500/40">
                  {tokenData.chain || 'SOLANA'}
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Launch token on external DEXs, explorers, charting terminals &amp; social feeds
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Contract Address Bar */}
        {tokenData.mintOrCa && (
          <div className="px-4 py-3 bg-[#0A0F1D] border-b border-[#1E293B] flex items-center justify-between text-xs">
            <div className="flex items-center space-x-2 overflow-hidden mr-2">
              <span className="text-slate-500 text-[11px] uppercase">Mint / CA:</span>
              <code className="text-cyan-300 font-mono text-[11px] truncate select-all">
                {tokenData.mintOrCa}
              </code>
            </div>
            <button
              onClick={handleCopyCa}
              className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 flex items-center space-x-1 text-[11px] flex-shrink-0 transition-colors"
            >
              {copied ? (
                <>
                  <Check className="w-3 h-3 text-emerald-400" />
                  <span className="text-emerald-400 font-bold">Copied</span>
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3 text-slate-400" />
                  <span>Copy CA</span>
                </>
              )}
            </button>
          </div>
        )}

        {/* External Links Grid */}
        <div className="p-4 space-y-2.5 max-h-[60vh] overflow-y-auto">
          <div className="text-[11px] uppercase text-slate-400 font-bold tracking-wider mb-2">
            Select External Platform:
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {links
              .filter((l) => l.isAvailable)
              .map((link) => {
                return (
                  <a
                    key={link.id}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-3 rounded-xl bg-[#11182B] hover:bg-[#16213B] border border-[#1E293B] hover:border-cyan-500/50 transition-all flex flex-col justify-between group"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-bold text-sm text-white group-hover:text-cyan-300 flex items-center space-x-1.5">
                        {link.id === 'dexscreener' && <TrendingUp className="w-4 h-4 text-cyan-400" />}
                        {link.id === 'pumpfun' && <Flame className="w-4 h-4 text-rose-400" />}
                        {link.id === 'gmgn' && <TrendingUp className="w-4 h-4 text-emerald-400" />}
                        {link.id === 'birdeye' && <Globe className="w-4 h-4 text-blue-400" />}
                        {link.id === 'solscan' && <Compass className="w-4 h-4 text-purple-400" />}
                        {link.id === 'photon' && <Zap className="w-4 h-4 text-amber-400" />}
                        {link.id === 'bullx' && <Share2 className="w-4 h-4 text-teal-400" />}
                        {link.id === 'axiom' && <Zap className="w-4 h-4 text-orange-400" />}
                        {link.id === 'twitter' && <span className="font-bold text-sky-400">𝕏</span>}
                        {link.id === 'telegram' && <Send className="w-4 h-4 text-blue-400" />}
                        {link.id === 'website' && <Globe className="w-4 h-4 text-emerald-400" />}
                        <span>{link.name}</span>
                      </span>
                      <ExternalLink className="w-3.5 h-3.5 text-slate-500 group-hover:text-cyan-400 transition-colors" />
                    </div>
                    <p className="text-[10px] text-slate-400 leading-tight">
                      {link.description}
                    </p>
                  </a>
                );
              })}
          </div>
        </div>

        {/* Modal Footer */}
        <div className="p-3 bg-[#090D17] border-t border-[#1E293B] flex items-center justify-between text-xs text-slate-400">
          <span>Opens directly in a new browser tab</span>
          <button
            onClick={onClose}
            className="px-4 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-white font-semibold transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
