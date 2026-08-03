# @hedgents/stablecoin-rail-react

React subscription and actions for `RailFlow`. The package renders no UI, allowing products to build their own wallet and funding experience.

```bash
npm install @hedgents/stablecoin-rail @hedgents/stablecoin-rail-react
```

```tsx
import { useRailFlow } from "@hedgents/stablecoin-rail-react";

const { snapshot, quote, prepareFunding, refreshFunding } = useRailFlow(client);
```
