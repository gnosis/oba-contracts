import { expect } from "chai";
import { BigNumber, Contract } from "ethers";
import { ethers, waffle } from "hardhat";

import { computeOrderUid, SettlementReader } from "../src/ts";

describe("GPv2AllowListAuthentication", () => {
  const [deployer, owner, ...traders] = waffle.provider.getWallets();
  let settlement: Contract;
  let reader: Contract;
  let settlmentReader: SettlementReader;

  beforeEach(async () => {
    const GPv2Settlement = await ethers.getContractFactory(
      "GPv2SettlementTestInterface",
      deployer,
    );

    const SettlementStorageReader = await ethers.getContractFactory(
      "SettlementStorageReader",
      deployer,
    );
    reader = await SettlementStorageReader.deploy();
    settlement = await GPv2Settlement.deploy(owner.address);
    settlmentReader = new SettlementReader(settlement, reader);
  });

  describe("filledAmountsForOrders(bytes[] calldata orderUids)", () => {
    it("returns expected filledAmounts", async () => {
      // construct 3 unique order Ids and invalidate the first two.
      const orderUids = [0, 1, 2].map((i) =>
        computeOrderUid({
          orderDigest: "0x" + "11".repeat(32),
          owner: traders[i].address,
          validTo: 2 ** 32 - 1,
        }),
      );

      await settlement.connect(traders[0]).invalidateOrder(orderUids[0]);
      await settlement.connect(traders[1]).invalidateOrder(orderUids[1]);

      expect(
        await settlmentReader.filledAmountsForOrders(orderUids),
      ).to.deep.equal([
        ethers.constants.MaxUint256,
        ethers.constants.MaxUint256,
        BigNumber.from(0),
      ]);
    });
  });
});