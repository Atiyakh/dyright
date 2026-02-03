"""
ndarray.py

Inspection script for numpy ndarray objects.
Returns a formatted preview of the array for hover display.
"""

from typing import Any


def inspect(arr: Any) -> str:
    """
    Inspect a numpy ndarray and return a formatted string representation.

    Args:
        arr: A numpy ndarray object

    Returns:
        A string suitable for display in an editor hover tooltip
    """
    import numpy as np

    lines = []

    # Shape and dtype
    lines.append(f"Shape: {arr.shape}")
    lines.append(f"Dtype: {arr.dtype}")
    lines.append(f"Size: {arr.size:,} elements")

    # Dimensions
    if arr.ndim == 1:
        lines.append(f"Dimensions: 1D vector")
    elif arr.ndim == 2:
        lines.append(f"Dimensions: 2D matrix ({arr.shape[0]}×{arr.shape[1]})")
    else:
        lines.append(f"Dimensions: {arr.ndim}D tensor")

    # Memory
    mem_mb = arr.nbytes / (1024 ** 2)
    if mem_mb < 1:
        lines.append(f"Memory: {arr.nbytes / 1024:.2f} KB")
    else:
        lines.append(f"Memory: {mem_mb:.2f} MB")

    # Statistics for numeric arrays
    if np.issubdtype(arr.dtype, np.number):
        lines.append("")
        lines.append("Statistics:")
        try:
            # Handle potential NaN values
            if np.issubdtype(arr.dtype, np.floating):
                clean_arr = arr[~np.isnan(arr)]
                nan_count = arr.size - clean_arr.size
                if nan_count > 0:
                    lines.append(f"  NaN count: {nan_count:,}")
            else:
                clean_arr = arr.flatten()

            if clean_arr.size > 0:
                lines.append(f"  Min: {np.min(clean_arr)}")
                lines.append(f"  Max: {np.max(clean_arr)}")
                lines.append(f"  Mean: {np.mean(clean_arr):.6g}")
                lines.append(f"  Std: {np.std(clean_arr):.6g}")
        except Exception as e:
            lines.append(f"  (Stats unavailable: {e})")

    # Preview
    lines.append("")
    lines.append("Preview:")

    # Limit preview size
    np.set_printoptions(threshold=50, edgeitems=3, linewidth=60)
    preview = np.array2string(arr, max_line_width=60, threshold=50, edgeitems=3)
    np.set_printoptions()  # Reset to defaults

    # Truncate very long previews
    preview_lines = preview.split('\n')
    if len(preview_lines) > 10:
        preview = '\n'.join(preview_lines[:5] + ['  ...'] + preview_lines[-3:])

    lines.append(preview)

    # Additional info for special array types
    if hasattr(arr, 'flags'):
        flags = []
        if arr.flags.c_contiguous:
            flags.append('C-contiguous')
        if arr.flags.f_contiguous:
            flags.append('F-contiguous')
        if not arr.flags.writeable:
            flags.append('read-only')
        if flags:
            lines.append("")
            lines.append(f"Flags: {', '.join(flags)}")

    return "\n".join(lines)
