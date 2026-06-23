import { Opportunity } from './Opportunity';

export interface ExecutionPlan {
  opportunity:          Opportunity;
  loanToken:            string;
  loanAmount:           string;        // bigint as string
  routerAddress:        string;
  route:                string;        // encoded ABI path
  minAmountOut:         string;        // bigint as string
  gasLimit:             string;        // bigint as string
  maxFeePerGas:         string;        // bigint as string
  maxPriorityFeePerGas: string;        // bigint as string
  targetBlock:          number;
  builderUrls:          string[];
  estimatedProfitUsd:   number;
  ethPriceUsd6:         string;        // ETH price in 6-dec USDC units (bigint as string)
}
