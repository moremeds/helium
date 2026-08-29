# Component dependencies

Each YAML file declares one directed dependency edge. `from` is the dependent;
`to` is the component it needs. The bounded bundle loader validates all edges
against the component registry and rejects dangling references or cycles before
installing any part of a tenant bundle.

```yaml
from: apex
to: postgres
```

Keep edges separate from component documents so topology changes are explicit
and reviewable without changing a component's identity or mutation ownership.
