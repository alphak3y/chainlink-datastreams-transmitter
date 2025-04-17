import { ActionFunctionArgs, redirect } from '@remix-run/node';
import { Form, useNavigate } from '@remix-run/react';
import { logger } from 'server/services/logger';
import { addEVMChain } from 'server/store';
import { printError } from 'server/utils';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const data = Object.fromEntries(formData);

  const chain = {
    id: Number(data.id),
    name: data.name,
    nativeCurrency: {
      decimals: Number(data.currencyDecimals),
      name: data.currencyName,
      symbol: data.currencySymbol,
    },
    rpcUrls: {
      default: { http: [data.rpc] },
    },
    testnet: data.testnet,
  };

  try {
    if (!chain) {
      logger.warn('⚠ Invalid chain input', { data });
      return null;
    }
    if (!chain.id || isNaN(Number(chain.id))) {
      logger.warn('⚠ Invalid chain id', { chain });
      return null;
    }
    if (!chain.name) {
      logger.warn('⚠ Chain name is missing', { chain });
      return null;
    }
    if (!chain.nativeCurrency) {
      logger.warn('⚠ Native currency object is missing', { chain });
      return null;
    }
    if (!chain.nativeCurrency.name) {
      logger.warn('⚠ Chain native currency name is missing', { chain });
      return null;
    }
    if (!chain.nativeCurrency.symbol) {
      logger.warn('⚠ Chain native currency symbol is missing', { chain });
      return null;
    }
    if (
      !chain.nativeCurrency.decimals ||
      isNaN(Number(chain.nativeCurrency.decimals))
    ) {
      logger.warn('⚠ Invalid chain native currency decimals', { chain });
      return null;
    }
    if (!chain.rpcUrls) {
      logger.warn('⚠ RPC urls object is missing', { chain });
      return null;
    }
    if (!chain.rpcUrls.default) {
      logger.warn('⚠ Default RPC urls object is missing', { chain });
      return null;
    }
    if (
      !chain.rpcUrls.default.http ||
      chain.rpcUrls.default.http.length === 0 ||
      !chain.rpcUrls.default.http[0]
    ) {
      logger.warn('⚠ Default http RPC url is missing', { chain });
      return null;
    }

    await addEVMChain(chain.id.toString(), JSON.stringify(chain));
    logger.info(`📢 New chain has been added`, { chain });
    return redirect('/chain/switch');
  } catch (error) {
    logger.error(printError(error), error);
    console.error(error);
    return null;
  }
}

export default function NewEVMChain() {
  const navigate = useNavigate();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Add new EVM chain</CardTitle>
      </CardHeader>
      <CardContent>
        <Form method="post" className="space-y-4" id="add-chain-form">
          <div>
            <Label htmlFor="id">Chain ID</Label>
            <Input name="id" />
          </div>
          <div>
            <Label htmlFor="name">Chain name</Label>
            <Input name="name" />
          </div>
          <p>Native currency</p>
          <div>
            <Label htmlFor="currencyName">Native currency name</Label>
            <Input name="currencyName" />
          </div>
          <div>
            <Label htmlFor="currencySymbol">Native currency symbol</Label>
            <Input name="currencySymbol" />
          </div>
          <div>
            <Label htmlFor="currencyDecimals">Native currency decimals</Label>
            <Input name="currencyDecimals" />
          </div>
          <div>
            <Label htmlFor="rpc">RPC URL</Label>
            <Input name="rpc" />
          </div>
          <div>
            <Label htmlFor="testnet">Testnet</Label>
            <Input name="testnet" />
          </div>
          <div className="space-x-4">
            <Button type="submit">Submit</Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => navigate(-1)}
            >
              Back
            </Button>
          </div>
        </Form>
      </CardContent>
    </Card>
  );
}
