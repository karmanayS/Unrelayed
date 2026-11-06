// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// A validation-safe copy of the Tornado Cash 0.1 ETH pool's Groth16 verifier (BUILD-PLAN §S4).
///
/// The devnet's predeployed Tornado Verifier (0xECD2…f01, the original Dec-2019 deployment) calls the pairing
/// precompiles with `staticcall(sub(gas, 2000), …)`, i.e. `GAS SUB STATICCALL`, which the alt-mempool rejects inside a
/// VERIFY frame ("payer uses banned opcode: GAS", T3.6): GAS is allowed only immediately before a *CALL. This contract
/// performs the same verification with `staticcall(gas(), …)` so that GAS is immediately followed by STATICCALL.
///
/// Verifying key: copied verbatim from tornadocash/tornado-core release v2.0 `Verifier.sol` (snarkjs-generated,
/// Copyright 2017 Christian Reitwiessner, 2019 OKIMS, MIT), the key the deployed Verifier embeds (see PROGRESS.md T4.1).
/// Input parsing is the same: `abi.decode(proof, (uint[2], uint[2], uint[2], uint[2]))`, B = [[b1], [b2]], every
/// public input must be < the SNARK scalar field, and the same pairing equation. Where the original executes INVALID on
/// a failed precompile call (another banned opcode), this one reverts; both make `verifyProof` fail.
///
/// The Tornado pool keeps using its own Verifier during the withdrawal itself; this copy is used only inside VERIFY.
contract Groth16TornadoVerifier {
    uint256 internal constant SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 internal constant PRIME_Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    struct G1Point {
        uint256 X;
        uint256 Y;
    }

    // Encoding of field elements is: X[0] * z + X[1]
    struct G2Point {
        uint256[2] X;
        uint256[2] Y;
    }

    error PairingAddFailed();
    error PairingMulFailed();
    error PairingOpcodeFailed();

    // ------------------------------------------------------------------------------------------ verifying key ----

    function _vk()
        internal
        pure
        returns (G1Point memory alfa1, G2Point memory beta2, G2Point memory gamma2, G2Point memory delta2, G1Point[7] memory IC)
    {
        alfa1 = G1Point(14083060544450230494753274689662527554173093259052677053963403611543108812248, 4706358536309759497515629700429717613728395864036029914779603000183617648928);
        beta2 = G2Point(
            [16219376067261068540504773162427353135531573767414264044630641576986412148841, 11226478626154379929692040045672180496625001440073645894895473453499733630608],
            [8662043286651336594833933468521973267084981586202736778519782026658563113819, 5942204661444759280424140647067377540347290706910798648472025938632189112985]
        );
        gamma2 = G2Point(
            [5626774539960215411062721749577193079747643943552704413404404262438418256316, 9019372327661379039595737818991664049719738650451402651660959581913338994854],
            [21092692879600416126570996361460322936290640865421745471798870901476359011654, 9562621902064186952244630067028615031672773927765582067796589601830914136863]
        );
        delta2 = G2Point(
            [15895226675259918394214944850094992600763639881245050921639726020135193652688, 8066794343152224768444030087741836548721200404739800154831732767644473461476],
            [2091512572979570673813987427579756573526730039480975604103592522881026646949, 15957537187230612698014796603169934934345666788241949100809795704331873734963]
        );
        IC[0] = G1Point(14112255618296752664987088318060807163751325065279686739401083407169811107624, 12125289624680902628733420759546824791467428117812768926606015515391099666551);
        IC[1] = G1Point(9950061763761971651364890451617100497514634553916860166198204152844612131077, 21535612280842336626995215571028050552370291719642409660905444643494169974931);
        IC[2] = G1Point(13629729267373883091784437554800598646370914526466282534161591457204234303940, 20428953590301985331608379836857790556503633933796007036040402171229917977521);
        IC[3] = G1Point(3785379534194287071601933141657029654649536871130067525982297509612327206924, 20441720781313152301739076910621905177933653643381029091599841534154495485733);
        IC[4] = G1Point(8174876566887573867022571764285261688265531058998171958730684499818568021399, 15364158076213537047194249827614090601580933367596700053241089406052131015891);
        IC[5] = G1Point(9663480153820773462766642876957017446277546738016922976831320957266750385069, 11455348672789641736424763421225888127466400796123190592860299461638477062914);
        IC[6] = G1Point(9997392752408677018847679602311243591939016081244612283626393457143697191318, 1284349834049952760295840793422778426148802044355256369588105110406727218438);
    }

    // ------------------------------------------------------------------------------------- pairing (precompiles) ----

    /// @return the negation of p, i.e. p.addition(p.negate()) should be zero.
    function _negate(G1Point memory p) internal pure returns (G1Point memory) {
        if (p.X == 0 && p.Y == 0) return G1Point(0, 0);
        return G1Point(p.X, PRIME_Q - (p.Y % PRIME_Q));
    }

    /// ECADD (0x06).
    function _addition(G1Point memory p1, G1Point memory p2) internal view returns (G1Point memory r) {
        uint256[4] memory input = [p1.X, p1.Y, p2.X, p2.Y];
        bool success;
        assembly ("memory-safe") {
            success := staticcall(gas(), 0x06, input, 0x80, r, 0x40)
        }
        if (!success) revert PairingAddFailed();
    }

    /// ECMUL (0x07).
    function _scalarMul(G1Point memory p, uint256 s) internal view returns (G1Point memory r) {
        uint256[3] memory input = [p.X, p.Y, s];
        bool success;
        assembly ("memory-safe") {
            success := staticcall(gas(), 0x07, input, 0x60, r, 0x40)
        }
        if (!success) revert PairingMulFailed();
    }

    /// ECPAIRING (0x08) over four pairs: e(a1, a2) · e(b1, b2) · e(c1, c2) · e(d1, d2) == 1.
    function _pairingProd4(
        G1Point memory a1, G2Point memory a2,
        G1Point memory b1, G2Point memory b2,
        G1Point memory c1, G2Point memory c2,
        G1Point memory d1, G2Point memory d2
    ) internal view returns (bool) {
        uint256[24] memory input = [
            a1.X, a1.Y, a2.X[0], a2.X[1], a2.Y[0], a2.Y[1],
            b1.X, b1.Y, b2.X[0], b2.X[1], b2.Y[0], b2.Y[1],
            c1.X, c1.Y, c2.X[0], c2.X[1], c2.Y[0], c2.Y[1],
            d1.X, d1.Y, d2.X[0], d2.X[1], d2.Y[0], d2.Y[1]
        ];
        uint256[1] memory out;
        bool success;
        assembly ("memory-safe") {
            success := staticcall(gas(), 0x08, input, 0x300, out, 0x20)
        }
        if (!success) revert PairingOpcodeFailed();
        return out[0] != 0;
    }

    // --------------------------------------------------------------------------------------------- verify ----

    function _verify(uint256[6] calldata input, G1Point memory A, G2Point memory B, G1Point memory C) internal view returns (bool) {
        (G1Point memory alfa1, G2Point memory beta2, G2Point memory gamma2, G2Point memory delta2, G1Point[7] memory IC) = _vk();
        // Compute the linear combination vk_x
        G1Point memory vkX = G1Point(0, 0);
        for (uint256 i = 0; i < 6; i++) {
            require(input[i] < SNARK_SCALAR_FIELD, "verifier-gte-snark-scalar-field");
            vkX = _addition(vkX, _scalarMul(IC[i + 1], input[i]));
        }
        vkX = _addition(vkX, IC[0]);
        return _pairingProd4(_negate(A), B, alfa1, beta2, vkX, gamma2, C, delta2);
    }

    /// Same ABI and semantics as the deployed Tornado Verifier's `verifyProof(bytes,uint256[6])` (selector 0x695ef6f9).
    function verifyProof(bytes calldata proof, uint256[6] calldata inputs) external view returns (bool) {
        (uint256[2] memory a, uint256[2] memory b1, uint256[2] memory b2, uint256[2] memory c) =
            abi.decode(proof, (uint256[2], uint256[2], uint256[2], uint256[2]));
        return _verify(inputs, G1Point(a[0], a[1]), G2Point([b1[0], b1[1]], [b2[0], b2[1]]), G1Point(c[0], c[1]));
    }
}
