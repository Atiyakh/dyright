---
title: 'Dyright: Runtime-Augmented Static Type Analysis for Jupyter Notebooks'
tags:
  - Python
  - type checking
  - Jupyter notebooks
  - static analysis
  - runtime inspection
  - language server protocol
authors:
  - name: Atiya Alkhodari
    orcid: 0009-0008-3133-005X
    corresponding: true
    affiliation: 1
affiliations:
  - name: Independent Researcher
    index: 1
date: 3 February 2026
bibliography: paper.bib

---

# Summary

Dyright extends Microsoft's Pyright static type checker with controlled runtime inspection capabilities specifically designed for Jupyter notebook environments. By combining static type inference with dynamic introspection of live kernel objects, Dyright provides developers with richer hover information that reflects the actual state of variables during interactive data science workflows. This hybrid approach addresses a fundamental limitation of purely static analysis tools when applied to the exploratory, iterative nature of notebook-based programming.

# Statement of Need

Static type checkers like Pyright [@pyright], mypy [@mypy], and Pylance have become essential tools in the Python ecosystem, catching type errors before runtime and providing intelligent code completion. However, in Jupyter notebook environments, these tools face a fundamental challenge: the disconnect between static analysis and runtime reality.

Consider a data scientist working with a pandas DataFrame:

```python
df = pd.read_csv("sales_data.csv")  # Columns unknown at static analysis time
df_filtered = df[df["revenue"] > 1000]  # Is "revenue" a valid column?
```

A static type checker can determine that `df` is of type `pandas.DataFrame`, but cannot know the actual column names present in the data, the shape of the DataFrame, memory consumption, data types of individual columns, or statistical properties of the data.

This information gap is particularly problematic in notebook environments where data is loaded dynamically from external sources, transformations are applied iteratively, the "ground truth" exists only in the running kernel, and developers frequently hover over variables to understand their current state [@kluyver2016jupyter].

Dyright addresses this need by augmenting static type information with controlled runtime inspection, providing a unified hover experience that combines type-theoretic guarantees with empirical runtime data.

# State of the Field

Several tools exist for Python type checking and notebook development environments:

`Pyright` [@pyright] is Microsoft's fast static type checker for Python, providing comprehensive type analysis and serving as the foundation for the Pylance VS Code extension. `mypy` [@mypy] is the reference implementation of Python's type checking ecosystem, offering thorough static analysis but without runtime integration capabilities.

For notebook environments, `Jupyter` [@kluyver2016jupyter] provides the interactive computing platform, while the Jupyter Variable Inspector and similar extensions offer runtime variable exploration but operate independently from static analysis tools. `nbdev` [@nbdev] provides notebook-centric development workflows but focuses on documentation and testing rather than type-aware runtime inspection.

Dyright was built rather than contributing to existing projects for several reasons. First, tight integration with the Language Server Protocol (LSP) [@lsp] enables seamless hover experiences that combine static and runtime information in a single tooltip. Second, the multi-process architecture with process isolation ensures that inspection operations cannot corrupt kernel state or cause resource exhaustion—a critical safety requirement for production notebook environments. Third, Dyright's configurable inspection policies allow users to control exactly which types are inspected and with what resource limits, addressing the varying needs of different data science workflows.

# Software Design

Dyright employs a multi-process architecture that maintains strict separation between the language server, the Jupyter kernel, and the inspection sandbox. This design prioritizes safety while enabling rich runtime introspection.

The system consists of five main components:

1. **Configuration Layer**: Manages inspection policies for different types through a declarative `lspContext.json` file, providing user control, safety boundaries, and extensibility.

2. **Kernel Communication Layer**: Implements the Jupyter messaging protocol [@jupyter_protocol] over ZeroMQ sockets to communicate with running IPython kernels for type validation, size estimation, and object serialization.

3. **Object Serialization Strategy**: Implements three strategies (shallow copy, deep copy, and pickle) with configurable bounds to safely transfer objects from the kernel to the inspection server.

4. **Inspection Server**: A separate Python process that receives serialized objects and executes type-specific inspection scripts with enforced resource limits (CPU, memory, time).

5. **Hover Provider Integration**: Extends Pyright's existing hover functionality to compose combined static and runtime information while gracefully falling back when runtime inspection is unavailable.

The orchestration service implements a careful pipeline: configuration lookup, kernel connection verification, type validation, size checking, serialization, inspection execution, and result formatting. Every step can fail gracefully, ensuring that inspection failures never degrade the core static analysis experience.

# Research Impact Statement

Dyright demonstrates that static type analysis and runtime inspection can be productively combined in notebook environments. The extension-point design in the language server base class allows the standard Pyright experience to remain unchanged for non-notebook use cases while enabling enhanced functionality for interactive data science workflows.

The configurable nature of Dyright's inspection policies makes it suitable for diverse use cases, from exploratory data analysis with pandas DataFrames to numerical computing with NumPy arrays. By providing bounded resource consumption and process isolation, Dyright addresses the reliability requirements of professional development environments.

# Mathematics

Dyright's resource bounding ensures predictable performance. For any inspection operation, the worst-case resource consumption is bounded by:

$$\text{Memory}_{\text{max}} = \text{maxSizeMb} + \text{resourceLimits.ramMb}$$

$$\text{Time}_{\text{max}} = \text{timeoutMs} + \text{networkLatency}$$

where `maxSizeMb` bounds the serialized object size and `resourceLimits.ramMb` bounds the inspection process memory.

# AI Usage Disclosure

No generative AI tools were used in the development of this software, the writing of this manuscript, or the preparation of supporting materials.

# Acknowledgements

We acknowledge the Microsoft Pyright team for creating the foundational static type checker that Dyright extends. We also acknowledge the Jupyter project contributors for the messaging protocol and kernel architecture that enables runtime inspection capabilities.

# References
