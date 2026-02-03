"""
series.py

Inspection script for pandas Series objects.
Returns a formatted preview of the Series for hover display.
"""

from typing import Any


def inspect(series: Any) -> str:
    """
    Inspect a pandas Series and return a formatted string representation.

    Args:
        series: A pandas Series object

    Returns:
        A string suitable for display in an editor hover tooltip
    """
    lines = []

    # Basic info
    lines.append(f"Name: {series.name if series.name else '(unnamed)'}")
    lines.append(f"Length: {len(series):,}")
    lines.append(f"Dtype: {series.dtype}")

    # Null count
    null_count = series.isna().sum()
    if null_count > 0:
        null_pct = null_count / len(series) * 100 if len(series) > 0 else 0
        lines.append(f"Nulls: {null_count:,} ({null_pct:.1f}%)")

    # Statistics for numeric types
    if series.dtype.kind in 'iufb':  # int, unsigned, float, boolean
        lines.append("")
        lines.append("Statistics:")
        try:
            lines.append(f"  Min: {series.min()}")
            lines.append(f"  Max: {series.max()}")
            lines.append(f"  Mean: {series.mean():.4f}")
            lines.append(f"  Std: {series.std():.4f}")
        except Exception:
            pass

    # Value counts for categorical-like data
    if series.dtype == 'object' or series.dtype.name == 'category':
        lines.append("")
        lines.append("Top values:")
        vc = series.value_counts().head(5)
        for val, count in vc.items():
            pct = count / len(series) * 100 if len(series) > 0 else 0
            val_str = str(val)[:20] + "..." if len(str(val)) > 20 else str(val)
            lines.append(f"  {val_str}: {count:,} ({pct:.1f}%)")

    # Preview
    lines.append("")
    lines.append("Preview:")
    lines.append(str(series.head(5).to_string()))

    # Memory
    lines.append("")
    mem_kb = series.memory_usage(deep=True) / 1024
    if mem_kb < 1024:
        lines.append(f"Memory: {mem_kb:.2f} KB")
    else:
        lines.append(f"Memory: {mem_kb/1024:.2f} MB")

    return "\n".join(lines)
