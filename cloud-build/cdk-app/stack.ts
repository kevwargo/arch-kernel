import { CfnOutput, CustomResource, Stack } from "aws-cdk-lib";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { CustomImageProvider } from "./cr-provider";

const env = {
  region: process.env.CDK_DEFAULT_REGION,
  account: process.env.CDK_DEFAULT_ACCOUNT,
};

export class KBuildStack extends Stack {
  constructor(scope: Construct) {
    super(scope, "KBuild", { env });

    const provider = new CustomImageProvider(this, "Provider");

    const ec2UserScript = [
      "cd",
      "git clone https://github.com/kevwargo/arch-kernel",
      "cd arch-kernel",
      "docker compose build",
    ].join(" && ");
    // TODO: fix this
    /*
    [ec2-user@ip-172-31-47-89 arch-kernel]$ make build
    docker compose run --rm kbuild makepkg --noextract --force
    [+] Creating 1/1
     ✔ Network arch-kernel_default  Created 0.1s
    ==> Making package: linux-kvz 6.18.2.arch2-1 (Mon Jan 19 12:47:20 2026)
    ==> Checking runtime dependencies...
    ==> Checking buildtime dependencies...
    ==> WARNING: Using existing $srcdir/ tree
    ==> Starting build()...
    /kbuild/PKGBUILD: line 87: cd: linux-6.18.2: No such file or directory
    ==> ERROR: A failure occurred in build().
        Aborting...

    make: *** [Makefile:24: build] Error 4 */

    const customImage = new CustomResource(this, "Image", {
      serviceToken: provider.serviceToken,
      properties: {
        Name: "kernel-builder",
        SourceImageId: StringParameter.valueFromLookup(
          this,
          "/aws/service/ami-amazon-linux-latest/al2023-ami-minimal-kernel-default-x86_64",
        ),
        PrepareScript: [
          "set -xe",
          "dnf install -y spal-release",
          "dnf install -y docker-cli docker-compose btrfs-progs screen git make",
          "dnf clean all",
          "systemctl enable docker",
          "usermod -a -G docker ec2-user",
          "systemctl start docker",
          `sudo -u ec2-user bash -c '${ec2UserScript}'`,
        ],
        RootVolSize: 10,
      },
    });

    new CfnOutput(this, "OutputImageId", {
      key: "ImageId",
      value: customImage.getAttString("ImageId"),
    });
    new CfnOutput(this, "OutputProviderArn", {
      key: "ProviderArn",
      value: provider.serviceToken,
    });
  }
}
