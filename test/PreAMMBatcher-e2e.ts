import { use, expect } from "chai";
import { ethers } from "@nomiclabs/buidler";
import { BigNumber, Contract, Signer, Wallet } from "ethers";
import { solidity } from "ethereum-waffle";

import { Order } from "../src/js/orders.spec";
import { generateTestCase } from "./resources/index";
import {
  baseTestInput,
  fourOrderTestInput,
  oneOrderSellingToken0IsObmittedTestInput,
  oneOrderSellingToken1IsObmittedTestInput,
  noSolutionTestInput,
  switchTokenTestInput,
} from "./resources/testExamples";

import { TestCase } from "./resources/models";

use(solidity);

async function setupOrders(
  orders: Order[],
  batcher: Contract,
): Promise<void> {
  for (const order of orders) {
    await order.sellToken.mint(order.wallet.address, order.sellAmount);
    await order.sellToken
      .connect(order.wallet)
      .approve(batcher.address, order.sellAmount);
  }
};

const fundUniswap = async (
  testCase: TestCase,
  walletDeployer: Signer,
  uniswapPair: Contract,
): Promise<void> => {
  const token0 = testCase.sellOrdersToken0[0].sellToken;
  const token1 = testCase.sellOrdersToken0[0].buyToken;
  await token0.mint(walletDeployer.getAddress(), testCase.fundingAMMToken0);
  await token1.mint(walletDeployer.getAddress(), testCase.fundingAMMToken1);
  await token0.transfer(uniswapPair.address, testCase.fundingAMMToken0);
  await token1.transfer(uniswapPair.address, testCase.fundingAMMToken0);
  await uniswapPair.mint(walletDeployer.getAddress(), { gasLimit: 500000 });
};

describe("PreAMMBatcher-e2e", async () => {
  const [
    walletDeployer,
    walletTrader1,
    walletTrader2,
    walletTrader3,
    walletTrader4,
    walletTrader5,
    walletTrader6,
  ] = await ethers.getSigners();

  const ERC20 = await ethers.getContractFactory("ERC20Mintable", walletDeployer);
  const PreAMMBatcher = await ethers.getContractFactory("PreAMMBatcher", walletDeployer);
  const UniswapV2Factory = await ethers.getContractFactory("UniswapV2Factory", walletDeployer);
  const UniswapV2Pair = await ethers.getContractFactory("UniswapV2Pair", walletDeployer);

  let batcher: Contract;
  let token0: Contract;
  let token1: Contract;
  let uniswapPair: Contract;
  let uniswapFactory: Contract;
  let uniswapPairAddress: string;

  const runScenarioOnchain = async (testCase: TestCase): Promise<void> => {
    await fundUniswap(testCase, walletDeployer, uniswapPair);
    await setupOrders(
      testCase.sellOrdersToken0.concat(testCase.sellOrdersToken1),
      batcher,
    );

    if (testCase.solution.sellOrdersToken0.length === 0) {
      await expect(
        batcher.batchTrade(
          testCase.getSellOrdersToken0Encoded(),
          testCase.getSellOrdersToken1Encoded(),
          { gasLimit: 6000000 },
        ),
      ).to.revertedWith("no solution found");
    } else {
      await expect(
        batcher.batchTrade(
          testCase.getSellOrdersToken0Encoded(),
          testCase.getSellOrdersToken1Encoded(),
          { gasLimit: 6000000 },
        ),
      )
        .to.emit(batcher, "BatchSettlement")
        .withArgs(
          testCase.solution.sellOrdersToken0[0].sellToken.address,
          testCase.solution.sellOrdersToken0[0].buyToken.address,
          testCase.solution.clearingPrice.denominator,
          testCase.solution.clearingPrice.numerator,
        );

      await asyncForEach(
        testCase.solution.sellOrdersToken0,
        async (order: Order) => {
          expect(
            await order.buyToken.balanceOf(order.wallet.address),
          ).to.be.equal(
            order.sellAmount
              .mul(testCase.solution.clearingPrice.denominator)
              .div(testCase.solution.clearingPrice.numerator)
              .mul(332)
              .div(333),
          );
        },
      );
      await asyncForEach(
        testCase.solution.sellOrdersToken1,
        async (order: Order) => {
          expect(
            await order.buyToken.balanceOf(order.wallet.address),
          ).to.be.equal(
            order.sellAmount
              .mul(testCase.solution.clearingPrice.numerator)
              .div(testCase.solution.clearingPrice.denominator)
              .mul(332)
              .div(333),
          );
        },
      );
    }
  };

  beforeEach(async () => {
    token0 = await ERC20.deploy();
    token1 = await ERC20.deploy();

    uniswapFactory = await UniswapV2Factory.deploy();
    await uniswapFactory.createPair(token0.address, token1.address, {
      gasLimit: 6000000,
    });
    
    uniswapPairAddress = await uniswapFactory.getPair(
      token0.address,
      token1.address,
    );
    uniswapPair = await UniswapV2Pair.deploy();
    uniswapPair = await uniswapPair.attach(uniswapPairAddress);

    batcher = await PreAMMBatcher.deploy(uniswapFactory.address);
  });

  it("example: baseTestInput", async () => {
    const testCase = generateTestCase(
      baseTestInput(
        token0,
        token1,
        [walletTrader1, walletTrader2],
        [walletTrader3, walletTrader4],
      ),
      true,
    );
    console.log(testCase.sellOrdersToken0.length);
    console.log(testCase.sellOrdersToken0[0].sellToken.address);
    expect(testCase.solution.sellOrdersToken0.length).to.be.equal(1);
    expect(testCase.solution.sellOrdersToken1.length).to.be.equal(1);
    await runScenarioOnchain(testCase);

    console.log(
      "auction clearing price:",
      testCase.solution.clearingPrice.numerator
        .mul(BigNumber.from("100000"))
        .div(testCase.solution.clearingPrice.denominator)
        .toString(),
    );
    console.log(
      "uniswap clearing price:",
      (await uniswapPair.getReserves())[0]
        .mul(100000)
        .div((await uniswapPair.getReserves())[1])
        .toString(),
    );
  });

  it("pre-batches four orders and settles left-overs to uniswap", async () => {
    const testCase = generateTestCase(
      fourOrderTestInput(
        token0,
        token1,
        [walletTrader1, walletTrader2],
        [walletTrader3, walletTrader4],
      ),
    );
    await runScenarioOnchain(testCase);
  });

  it("example: oneOrderSellingToken0IsObmittedTestInput", async () => {
    const testCase = generateTestCase(
      oneOrderSellingToken0IsObmittedTestInput(
        token0,
        token1,
        [walletTrader1, walletTrader2],
        [walletTrader3, walletTrader4],
      ),
      true,
    );
    console.log(testCase.sellOrdersToken0.length);
    console.log(testCase.sellOrdersToken0[0].sellToken.address);
    expect(testCase.solution.sellOrdersToken0.length).to.be.equal(1);
    expect(testCase.solution.sellOrdersToken1.length).to.be.equal(1);
    await runScenarioOnchain(testCase);
  });
  it("example: oneOrderSellingToken1IsObmittedTestInput", async () => {
    const testCase = generateTestCase(
      oneOrderSellingToken1IsObmittedTestInput(
        token0,
        token1,
        [walletTrader1, walletTrader2, walletTrader5, walletTrader6],
        [walletTrader3, walletTrader4],
      ),
      true,
    );

    expect(testCase.solution.sellOrdersToken0.length).to.be.equal(3);
    expect(testCase.solution.sellOrdersToken1.length).to.be.equal(2);
    await runScenarioOnchain(testCase);
  });
  it("example: noSolutionTestInput", async () => {
    const testCase = generateTestCase(
      noSolutionTestInput(
        token0,
        token1,
        [walletTrader1, walletTrader2, walletTrader5],
        [walletTrader3, walletTrader4, walletTrader6],
      ),
      true,
    );

    expect(testCase.solution.sellOrdersToken0.length).to.be.equal(0);
    expect(testCase.solution.sellOrdersToken1.length).to.be.equal(0);
    await runScenarioOnchain(testCase);
  });
  it("example: switchTokenTestInput", async () => {
    const testCase = generateTestCase(
      switchTokenTestInput(
        token0,
        token1,
        [walletTrader1, walletTrader2],
        [walletTrader3, walletTrader4, walletTrader5, walletTrader6],
      ),
      true,
    );

    expect(testCase.solution.sellOrdersToken0.length).to.be.equal(3);
    expect(testCase.solution.sellOrdersToken1.length).to.be.equal(2);
    await runScenarioOnchain(testCase);
  });
});
