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
