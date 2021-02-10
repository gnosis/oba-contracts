import IERC20 from "@openzeppelin/contracts/build/contracts/IERC20.json";
import { expect } from "chai";
import { Contract } from "ethers";
import { ethers, waffle } from "hardhat";

import { encodeInTransfers } from "./encoding";

describe("GPv2AllowanceManager", () => {
  const [
    deployer,
    recipient,
    nonRecipient,
    ...traders
  ] = waffle.provider.getWallets();

  let allowanceManager: Contract;

  beforeEach(async () => {
    const GPv2AllowanceManager = await ethers.getContractFactory(
      "GPv2AllowanceManager",
      recipient,
    );

    allowanceManager = await GPv2AllowanceManager.deploy();
  });

  describe("transferIn", () => {
    it("should revert if not called by the recipient", async () => {
      await expect(
        allowanceManager.connect(nonRecipient).transferIn([]),
      ).to.be.revertedWith("not allowance recipient");
    });

    it("should execute ERC20 transfers", async () => {
      const tokens = [
        await waffle.deployMockContract(deployer, IERC20.abi),
        await waffle.deployMockContract(deployer, IERC20.abi),
      ];

      const amount = ethers.utils.parseEther("13.37");
      await tokens[0].mock.transferFrom
        .withArgs(traders[0].address, recipient.address, amount)
        .returns(true);
      await tokens[1].mock.transferFrom
        .withArgs(traders[1].address, recipient.address, amount)
        .returns(true);

      await expect(
        allowanceManager.transferIn(
          encodeInTransfers([
            {
              owner: traders[0].address,
              sellToken: tokens[0].address,
              sellAmount: amount,
            },
            {
              owner: traders[1].address,
              sellToken: tokens[1].address,
              sellAmount: amount,
            },
          ]),
        ),
      ).to.not.be.reverted;
    });

    it("should revert on failed ERC20 transfers", async () => {
      const token = await waffle.deployMockContract(deployer, IERC20.abi);

      const amount = ethers.utils.parseEther("4.2");
      await token.mock.transferFrom
        .withArgs(traders[0].address, recipient.address, amount)
        .revertsWithReason("test error");

      await expect(
        allowanceManager.transferIn(
          encodeInTransfers([
            {
              owner: traders[0].address,
              sellToken: token.address,
              sellAmount: amount,
            },
          ]),
        ),
      ).to.be.revertedWith("test error");
    });
  });

  describe("transferDirect", () => {
    it("should revert if not called by the recipient", async () => {
      await expect(
        allowanceManager.connect(nonRecipient).transferIn([]),
      ).to.be.revertedWith("not allowance recipient");
    });

    it("should execute ERC20 transfers", async () => {
      const token = await waffle.deployMockContract(deployer, IERC20.abi);
      const [trader, ...targets] = traders.slice(0, 3);
      const amounts = [
        ethers.utils.parseEther("13.37"),
        ethers.utils.parseEther("42.0"),
      ];

      await token.mock.transferFrom
        .withArgs(trader.address, targets[0].address, amounts[0])
        .returns(true);
      await token.mock.transferFrom
        .withArgs(trader.address, targets[1].address, amounts[1])
        .returns(true);

      await expect(
        allowanceManager.transferDirect(token.address, trader.address, [
          {
            target: targets[0].address,
            amount: amounts[0],
          },
          {
            target: targets[1].address,
            amount: amounts[1],
          },
        ]),
      ).to.not.be.reverted;
    });

    it("should return the total transfer amount", async () => {
      const token = await waffle.deployMockContract(deployer, IERC20.abi);
      const [trader, ...targets] = traders.slice(0, 3);
      const amounts = [
        ethers.utils.parseEther("13.37"),
        ethers.utils.parseEther("42.0"),
      ];

      await token.mock.transferFrom
        .withArgs(trader.address, targets[0].address, amounts[0])
        .returns(true);
      await token.mock.transferFrom
        .withArgs(trader.address, targets[1].address, amounts[1])
        .returns(true);

      expect(
        await allowanceManager.callStatic.transferDirect(
          token.address,
          trader.address,
          [
            {
              target: targets[0].address,
              amount: amounts[0],
            },
            {
              target: targets[1].address,
              amount: amounts[1],
            },
          ],
        ),
      ).to.equal(amounts[0].add(amounts[1]));
    });

    it("should revert on failed ERC20 transfers", async () => {
      const token = await waffle.deployMockContract(deployer, IERC20.abi);

      const amount = ethers.utils.parseEther("4.2");
      await token.mock.transferFrom
        .withArgs(traders[0].address, recipient.address, amount)
        .revertsWithReason("test error");

      await expect(
        allowanceManager.transferDirect(token.address, traders[0].address, [
          {
            target: recipient.address,
            amount,
          },
        ]),
      ).to.be.revertedWith("test error");
    });
  });
});
