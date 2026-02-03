"""
dataframe.py

Inspection script for pandas DataFrame objects.
Returns a formatted preview of the DataFrame for hover display.
"""

from typing import Any


def inspect(df: Any) -> str:
    """
    Inspect a pandas DataFrame and return a formatted string representation.

    Args:
        df: A pandas DataFrame object

    Returns:
        A string suitable for display in an editor hover tooltip
    """
    import io

    lines = []

    # Shape info
    rows, cols = df.shape
    lines.append(f"Shape: ({rows:,} rows × {cols} columns)")

    # Column types
    lines.append("")
    lines.append("Columns:")
    for col in df.columns[:10]:  # Limit to first 10 columns
        dtype = df[col].dtype
        null_count = df[col].isna().sum()
        null_pct = (null_count / rows * 100) if rows > 0 else 0
        lines.append(f"  {col}: {dtype}" + (f" ({null_pct:.1f}% null)" if null_count > 0 else ""))

    if len(df.columns) > 10:
        lines.append(f"  ... and {len(df.columns) - 10} more columns")

    # Preview data
    lines.append("")
    lines.append("Preview:")

    # Capture df.head() output
    buffer = io.StringIO()
    df.head(5).to_string(buffer, max_cols=6, max_colwidth=20)
    preview = buffer.getvalue()
    lines.append(preview)

    # Memory usage
    lines.append("")
    mem_mb = df.memory_usage(deep=True).sum() / (1024 ** 2)
    lines.append(f"Memory: {mem_mb:.2f} MB")

    return "\n".join(lines)
