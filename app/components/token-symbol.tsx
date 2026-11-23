/** A collateral symbol with its coin mark. USDC-family symbols (USDC and
 * outcomia-tUSDC) get the USDC coin; anything else gets a lettered coin. */
export function TokenSymbol({ symbol }: { symbol: string }) {
  return (
    <span className="token-symbol">
      <TokenIcon symbol={symbol} />
      {symbol}
    </span>
  );
}

export function TokenIcon({ symbol }: { symbol: string }) {
  if (/usdc/i.test(symbol))
    return (
      <svg className="token-icon" viewBox="0 0 32 32" aria-hidden="true">
        <circle cx="16" cy="16" r="16" fill="#2775CA" />
        <path
          d="M12.2 7.6a9.2 9.2 0 0 0 0 16.8M19.8 7.6a9.2 9.2 0 0 1 0 16.8"
          fill="none"
          stroke="#fff"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <path
          d="M19.4 12.6c-.4-1.4-1.7-2.2-3.4-2.2-2 0-3.4 1-3.4 2.6 0 1.7 1.4 2.3 3.4 2.7 2.2.5 3.7 1.1 3.7 3 0 1.7-1.5 2.8-3.7 2.8-2 0-3.5-.9-3.9-2.5M16 8.6v2M16 21.5v1.9"
          fill="none"
          stroke="#fff"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
    );
  const letter = symbol.replace(/^[^A-Za-z]*t?(?=[A-Z])/, "").charAt(0) || "?";
  return (
    <svg className="token-icon" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="16" fill="var(--accent, #4f6bff)" />
      <text
        x="16"
        y="21.5"
        textAnchor="middle"
        fontSize="15"
        fontWeight="700"
        fill="#fff"
      >
        {letter.toUpperCase()}
      </text>
    </svg>
  );
}
