import { App, CfnOutput, Stack } from "aws-cdk-lib";
import { Vpc } from "aws-cdk-lib/aws-ec2";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { CustomImage } from "./custom-image";

const env = {
  region: process.env.CDK_DEFAULT_REGION,
  account: process.env.CDK_DEFAULT_ACCOUNT,
};

class KBuildStack extends Stack {
  constructor(scope: Construct) {
    super(scope, "KBuild", { env });

    const vpc = Vpc.fromLookup(this, "VPC", { isDefault: true });
    const image = new CustomImage(this, "KernelBuilder", {
      vpc,
      sourceImageId: StringParameter.valueFromLookup(
        this,
        "/aws/service/ami-amazon-linux-latest/al2023-ami-minimal-kernel-default-x86_64",
      ),
      commands: [
        "set -xe",
        "dnf install -y spal-release",
        "dnf install -y docker-cli docker-compose btrfs-progs screen git make",
        "dnf clean all",
        "systemctl enable docker",
        "usermod -a -G docker ec2-user",
      ],
      size: 15,
    });

    new CfnOutput(this, "OutputImageId", {
      key: "ImageId",
      value: image.imageId,
    });
    new CfnOutput(this, "OutputVPC", { key: "VpcId", value: vpc.vpcId });
  }
}

new KBuildStack(new App());
